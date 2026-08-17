"use client";

import QRCode from "qrcode/lib/browser.js";
import { ConvexClient } from "convex/browser";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Room as LiveRoom } from "livekit-client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { burstEditCandidates, listBurstAssets, uploadBurstCaptureAssets } from "@/lib/artifacts/burst-upload";
import {
  createRecorderStreamLease,
  DurableMediaRecorder,
  FrameRingBurstRecorder,
  RollingBurstRecorder,
  type RollingBurstCapture,
} from "@/lib/media";
import { tryCreateContactSheet } from "@/lib/media/video-artifact";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/realtime/constants";
import { BurstLibrary, type BurstLibraryEntry, type LocalBurstSource } from "./BurstLibrary";

type Feed = {
  id: string;
  label: string;
  angle: StageAngle;
  stream: MediaStream;
  local?: boolean;
  joinedAt: number;
};

type SceneLayout = "hero" | "duo" | "sweep";
type StageAngle = "LEFT" | "CENTER" | "RIGHT";
type ProgramComposition = 1 | 2 | 3 | 4 | 5 | "sweep";
type BurstPhase = "idle" | "capturing" | "preview" | "preserved";
type ArtifactPhase = "idle" | "saved" | "uploading" | "waiting" | "editing" | "rendering" | "ready" | "failed";
type SessionStatus = "lobby" | "live" | "ended";
type CameraPermissionState = "idle" | "requesting" | "granted" | "blocked" | "error";
type HostSession = { sessionId: string; slug: string; hostCapability: string };
type StoredParticipant = {
  participantId: string;
  participantCapability: string;
  livekitIdentity: string;
  sessionId: string;
};
type BurstCaptureSignal = {
  _id: Id<"bursts">;
  anchorServerMs: number;
  windowStartServerMs: number;
  windowEndServerMs: number;
  initiatedHere: boolean;
  readyContributionCount: number;
};
type ProgramBurstCaptureSignal = BurstCaptureSignal & {
  expectedParticipantIds: Id<"participants">[];
};

type Scene = {
  layout: SceneLayout;
  activeIds: string[];
  cutAt: number;
  revision: number;
  source?: "manual" | "deterministic" | "ai";
  reason?: string;
};

type WireMessage =
  | { type: "scene"; scene: Scene }
  | { type: "session_state"; state: "live" | "ended" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STAGE_ANGLES: StageAngle[] = ["LEFT", "CENTER", "RIGHT"];
const ANGLE_RANK: Record<StageAngle, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };
const PRODUCTION_SWEEP_STAGGER_MS = 1_350;
const AUTO_CADENCE_MS = 8_500;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

type BurstRecorder = {
  readonly readyAtMs: number | null;
  captureAt(anchorMs: number): Promise<RollingBurstCapture>;
  stop(): Promise<void>;
};

function needsSingleRecorderPipeline() {
  return /iPad|iPhone|iPod/iu.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function resumeVideo(video: HTMLVideoElement, stream: MediaStream, muted = true) {
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = muted;
  video.defaultMuted = muted;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  void video.play().catch(() => undefined);
}

function bindResilientPlayback(
  video: HTMLVideoElement,
  stream: MediaStream,
  muted = true,
) {
  const resume = () => resumeVideo(video, stream, muted);
  const resumeWhenVisible = () => {
    if (document.visibilityState === "visible") resume();
  };
  const tracks = stream.getVideoTracks();
  tracks.forEach((track) => {
    track.addEventListener("unmute", resume);
    track.addEventListener("mute", resume);
  });
  video.addEventListener("loadedmetadata", resume);
  video.addEventListener("canplay", resume);
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", resumeWhenVisible);
  resume();
  return () => {
    tracks.forEach((track) => {
      track.removeEventListener("unmute", resume);
      track.removeEventListener("mute", resume);
    });
    video.removeEventListener("loadedmetadata", resume);
    video.removeEventListener("canplay", resume);
    window.removeEventListener("pageshow", resume);
    document.removeEventListener("visibilitychange", resumeWhenVisible);
  };
}

function angleFromIdentity(identity: string): StageAngle {
  let hash = 0;
  for (let index = 0; index < identity.length; index += 1) {
    hash = (hash * 31 + identity.charCodeAt(index)) >>> 0;
  }
  return STAGE_ANGLES[hash % STAGE_ANGLES.length];
}

function inferStageAngle(identity: string, label?: string): StageAngle {
  const declared = label?.toUpperCase().match(/\b(LEFT|CENTER|RIGHT)\b/u)?.[1];
  return (declared as StageAngle | undefined) ?? angleFromIdentity(identity);
}

function shortCameraLabel(identity: string, label: string | undefined, angle: StageAngle): string {
  const cleaned = label
    ?.replace(new RegExp(`^${angle}\\s*[·|/—-]\\s*`, "iu"), "")
    .trim();
  return cleaned || `CAM ${identity.slice(-4).toUpperCase()}`;
}

function orderedByStage(feeds: Feed[]): Feed[] {
  return [...feeds].sort(
    (left, right) =>
      ANGLE_RANK[left.angle] - ANGLE_RANK[right.angle] || left.joinedAt - right.joinedAt,
  );
}

function pickAngle(feeds: Feed[], angle: StageAngle, rotation: number): Feed | undefined {
  const matches = feeds
    .filter((feed) => feed.angle === angle)
    .sort((left, right) => left.joinedAt - right.joinedAt);
  return matches.length ? matches[rotation % matches.length] : undefined;
}

function distinctFeeds(candidates: Array<Feed | undefined>, fallback: Feed[]): Feed[] {
  const seen = new Set<string>();
  const result: Feed[] = [];
  for (const candidate of [...candidates, ...fallback]) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

function stageAwareDirectorScene(feeds: Feed[], step: number): {
  layout: SceneLayout;
  feeds: Feed[];
  decision: string;
} {
  const ordered = orderedByStage(feeds);
  if (ordered.length <= 1) {
    return { layout: "hero", feeds: ordered, decision: `HERO · ${ordered[0]?.angle ?? "WAITING"}` };
  }
  const rotation = Math.floor(step / 6);
  const left = pickAngle(ordered, "LEFT", rotation);
  const center = pickAngle(ordered, "CENTER", rotation);
  const right = pickAngle(ordered, "RIGHT", rotation);
  const fallbackHero = ordered[step % ordered.length];

  switch (step % 6) {
    case 0: {
      const hero = center ?? fallbackHero;
      return { layout: "hero", feeds: [hero], decision: `HERO · ${hero.angle}` };
    }
    case 1: {
      const hero = left ?? fallbackHero;
      return { layout: "hero", feeds: [hero], decision: `CUT · ${hero.angle}` };
    }
    case 2: {
      const pair = distinctFeeds([left, right], ordered).slice(0, 2);
      return {
        layout: pair.length > 1 ? "duo" : "hero",
        feeds: pair,
        decision: pair.length > 1 ? `${pair[0].angle} + ${pair[1].angle}` : `HERO · ${pair[0].angle}`,
      };
    }
    case 3: {
      const hero = right ?? fallbackHero;
      return { layout: "hero", feeds: [hero], decision: `CUT · ${hero.angle}` };
    }
    case 4: {
      const pair = distinctFeeds([center, step % 2 ? left : right], ordered).slice(0, 2);
      return {
        layout: pair.length > 1 ? "duo" : "hero",
        feeds: pair,
        decision: pair.length > 1 ? `${pair[0].angle} + ${pair[1].angle}` : `HERO · ${pair[0].angle}`,
      };
    }
    default: {
      const sweep = distinctFeeds([left, center, right], ordered).slice(0, 5);
      return {
        layout: sweep.length > 1 ? "sweep" : "hero",
        feeds: sweep,
        decision: `SWEEP · ${sweep.map((feed) => feed.angle).join(" → ")}`,
      };
    }
  }
}

function compositionFromScene(scene: Scene): ProgramComposition {
  const requestedGrid = scene.reason?.match(/\b([1-5])-angle GRID\b/iu)?.[1];
  if (requestedGrid) return Number(requestedGrid) as ProgramComposition;
  if (scene.layout === "hero") return 1;
  if (scene.layout === "duo") return 2;
  return "sweep";
}

function directorReasonLabel(reason: string): string {
  return reason
    .replace(/\bTAKE\b/giu, "VIEW")
    .replace(/\s+/gu, " ")
    .trim();
}

function FeedVideo({ feed, muted = true }: { feed: Feed; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    return bindResilientPlayback(video, feed.stream, muted);
  }, [feed.stream, muted]);

  return <video ref={ref} data-feed-id={feed.id} autoPlay playsInline muted={muted} aria-label={`${feed.label} live camera`} />;
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="ManyVue Live">
      <Image
        className="brand-app-icon"
        src="/manyvue-icon.png"
        alt=""
        width={34}
        height={34}
        priority
        unoptimized
      />
      <span>MANY<span>VUE</span></span>
      <b>LIVE</b>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: "live" | "ready" | "warn"; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}><i aria-hidden="true" />{children}</span>;
}

function BurstExperience({
  phase,
  count,
  total,
}: {
  phase: BurstPhase;
  count: number;
  total: number;
}) {
  if (!(["capturing", "preview"] as BurstPhase[]).includes(phase)) return null;
  const locked = Math.max(count, phase === "preview" ? 1 : 0);
  const progress = total ? Math.max(12, Math.min(100, (locked / total) * 100)) : phase === "capturing" ? 42 : 12;

  return (
    <div className={`burst-experience phase-${phase}`} role="status" aria-live="assertive">
      <div className="burst-experience-copy">
        <p className="eyebrow">YOUR BURST · T−3 → T+3</p>
        {phase === "capturing" && <strong>SAVING THE MOMENT</strong>}
        {phase === "preview" && <strong>BURST SAVED</strong>}
        <span>
          {phase === "capturing"
            ? "Your camera keeps rolling while six synchronized seconds are preserved"
            : `${Math.max(locked, 1)} real ${Math.max(locked, 1) === 1 ? "angle" : "angles"} ready in View Bursts`}
        </span>
        <div className="burst-capture-progress" aria-label={`${locked} of ${Math.max(total, 1)} active angles locked`}>
          <i style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function ManyVueApp() {
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState<"program" | "camera">("program");
  const [sessionId, setSessionId] = useState("outside-live");
  const [participantId, setParticipantId] = useState("");
  const [participantName, setParticipantName] = useState("Crowd Camera");
  const [cameraAngle, setCameraAngle] = useState<StageAngle>("CENTER");
  const [participantCapability, setParticipantCapability] = useState("");
  const [convexSessionId, setConvexSessionId] = useState("");
  const [hostCapability, setHostCapability] = useState("");
  const [qr, setQr] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [joinExpanded, setJoinExpanded] = useState(true);
  const [mobileWallOpen, setMobileWallOpen] = useState(false);
  const [joinCopied, setJoinCopied] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [scene, setScene] = useState<Scene>({ layout: "hero", activeIds: [], cutAt: 0, revision: 0 });
  const [programComposition, setProgramComposition] = useState<ProgramComposition>(1);
  const [selectedCameraIds, setSelectedCameraIds] = useState<string[]>([]);
  const [, setTransport] = useState<"idle" | "connecting" | "live" | "rehearsal" | "error">("idle");
  const [transportMessage, setTransportMessage] = useState("");
  const [showLive, setShowLive] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("lobby");
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraOpening, setCameraOpening] = useState(false);
  const [cameraPermissionState, setCameraPermissionState] = useState<CameraPermissionState>("idle");
  const [cameraViewMode, setCameraViewMode] = useState<"mine" | "live">("mine");
  const [cameraFocusedFeedId, setCameraFocusedFeedId] = useState("");
  const [cameraStartedAt, setCameraStartedAt] = useState(0);
  const [recording, setRecording] = useState(false);
  const [burstBufferReady, setBurstBufferReady] = useState(false);
  const [selectedLive, setSelectedLive] = useState(false);
  const [burst, setBurst] = useState<{ id: string; at: number; count: number } | null>(null);
  const [ownedBurst, setOwnedBurst] = useState<{ id: string; at: number; count: number } | null>(null);
  const [burstHistory, setBurstHistory] = useState<BurstLibraryEntry[]>([]);
  const [burstLibraryOpen, setBurstLibraryOpen] = useState(false);
  const [burstPending, setBurstPending] = useState(false);
  const [burstPhase, setBurstPhase] = useState<BurstPhase>("idle");
  const [lastBurstCount, setLastBurstCount] = useState(0);
  const [clipUrl, setClipUrl] = useState("");
  const [clipExtension, setClipExtension] = useState<"mp4" | "webm">("webm");
  const [localBurstAsset, setLocalBurstAsset] = useState<LocalBurstSource | null>(null);
  const [uploadState, setUploadState] = useState<"idle" | "queued" | "uploading" | "uploaded" | "failed">("idle");
  const [artifactPhase, setArtifactPhase] = useState<ArtifactPhase>("idle");
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactMessage, setArtifactMessage] = useState("");
  const [directorAuto, setDirectorAuto] = useState(false);
  const [directorDecision, setDirectorDecision] = useState("MANUAL HOLD · START THE FILM, THEN CLICK AN ANGLE");
  const [programStarting, setProgramStarting] = useState(false);
  const [programStopping, setProgramStopping] = useState(false);
  const [hostPublishing, setHostPublishing] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const roomRef = useRef<LiveRoom | null>(null);
  const participantIdRef = useRef("");
  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<DurableMediaRecorder | null>(null);
  const rollingBurstRef = useRef<BurstRecorder | null>(null);
  const clipUrlRef = useRef("");
  const localBurstUrlRef = useRef("");
  const recorderStreamReleaseRef = useRef<(() => void) | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraOpeningRef = useRef(false);
  const burstCaptureIdsRef = useRef(new Set<string>());
  const burstCapturedIdsRef = useRef(new Set<string>());
  const burstArtifactIdsRef = useRef(new Set<string>());
  const burstCaptureAttemptsRef = useRef(new Map<string, number>());
  const burstCaptureHandlerRef = useRef<(sharedBurst: BurstCaptureSignal) => void>(() => undefined);
  const programMirrorRecordersRef = useRef(new Map<string, RollingBurstRecorder>());
  const programMirrorStartingRef = useRef(new Map<string, Promise<void>>());
  const programMirrorCapturedRef = useRef(new Set<string>());
  const programMirrorInFlightRef = useRef(new Set<string>());
  const programMirrorAttemptsRef = useRef(new Map<string, number>());
  const programMirrorHandlerRef = useRef<(sharedBurst: ProgramBurstCaptureSignal) => void>(() => undefined);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const recordingStartedRef = useRef(0);
  const convexRef = useRef<ConvexClient | null>(null);
  const sequenceRef = useRef(0);
  const convexInitRef = useRef(false);
  const renderIdRef = useRef("");
  const convexParticipantUnsubscribeRef = useRef<(() => void) | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const directorStepRef = useRef(0);
  const feedsRef = useRef<Feed[]>([]);
  const previousCrowdCameraCountRef = useRef(0);
  const sweepTokenRef = useRef(0);
  const serverClockOffsetRef = useRef(0);
  const programAutoStartAttemptedRef = useRef(false);
  const cameraAutoStartAttemptedRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextView = window.location.pathname === "/camera" || params.get("view") === "camera" ? "camera" : "program";
    const nextSession = params.get("session") || "outside-live";
    const stored = window.localStorage.getItem("manyvue-participant")
      ?? window.localStorage.getItem("crowdcut-participant")
      ?? crypto.randomUUID();
    const savedAngle = window.localStorage.getItem(`manyvue-angle-${nextSession}`)
      ?? window.localStorage.getItem(`crowdcut-angle-${nextSession}`);
    const initialAngle = STAGE_ANGLES.includes(savedAngle as StageAngle)
      ? (savedAngle as StageAngle)
      : angleFromIdentity(stored);
    window.localStorage.setItem("manyvue-participant", stored);
    window.localStorage.removeItem("crowdcut-participant");
    queueMicrotask(() => {
      setView(nextView);
      setSessionId(nextSession);
      setParticipantId(stored);
      participantIdRef.current = stored;
      setCameraAngle(initialAngle);
      setParticipantName(
        nextView === "program"
          ? "Program"
          : `${initialAngle} · ${stored.slice(0, 4).toUpperCase()}`,
      );
      setBooted(true);
    });
  }, []);

  const chooseCameraAngle = useCallback((angle: StageAngle) => {
    const suffix = participantName.match(/·\s*(.+)$/u)?.[1] ?? participantId.slice(0, 4).toUpperCase();
    const nextName = `${angle} · ${suffix}`;
    setCameraAngle(angle);
    setParticipantName(nextName);
    window.localStorage.setItem(`manyvue-angle-${sessionId}`, angle);
    window.localStorage.removeItem(`crowdcut-angle-${sessionId}`);
    if (roomRef.current?.state === "connected") {
      void roomRef.current.localParticipant.setName(nextName).catch(() => undefined);
    }
    if (convexRef.current && participantCapability && participantId) {
      void convexRef.current.mutation(api.participants.updateShotMetadata, {
        participantId: participantId as Id<"participants">,
        participantCapability,
        shotMetadata: {
          stageZone: angle.toLowerCase() as "left" | "center" | "right",
          framing: "unknown",
          confidence: 1,
          source: "self_reported",
        },
      }).catch((error) => setTransportMessage(error instanceof Error ? error.message : "Stage position could not update."));
    }
  }, [participantCapability, participantId, participantName, sessionId]);

  useEffect(() => {
    feedsRef.current = feeds;
  }, [feeds]);

  useEffect(() => {
    const client = convexRef.current;
    if (view !== "program" || !showLive || !client || !convexSessionId || !hostCapability) return;
    const participantIds = [...new Set(feeds.map((feed) => feed.id))];
    if (!participantIds.length) return;
    const confirm = () => client.mutation(api.participants.confirmVisibleMedia, {
      sessionId: convexSessionId as Id<"sessions">,
      hostCapability,
      participantIds: participantIds.map((id) => id as Id<"participants">),
    }).catch((error: unknown) => {
      console.error("Visible media lease confirmation failed", error);
    });
    void confirm();
    const timer = window.setInterval(() => void confirm(), 2_500);
    return () => window.clearInterval(timer);
  }, [convexSessionId, feeds, hostCapability, showLive, view]);

  const stopProgramMirrorRecorders = useCallback(async () => {
    const recorders = [...programMirrorRecordersRef.current.values()];
    programMirrorRecordersRef.current.clear();
    await Promise.all(recorders.map((recorder) => recorder.stop().catch(() => undefined)));
  }, []);

  useEffect(() => {
    if (view !== "program" || !showLive) {
      void stopProgramMirrorRecorders();
      return;
    }

    const productionFeeds = feeds.filter((feed) => feed.stream.getVideoTracks().some((track) => track.readyState === "live"));
    const liveIds = new Set(productionFeeds.map((feed) => feed.id));
    for (const [feedId, recorder] of programMirrorRecordersRef.current) {
      if (liveIds.has(feedId)) continue;
      programMirrorRecordersRef.current.delete(feedId);
      void recorder.stop().catch(() => undefined);
    }

    for (const feed of productionFeeds) {
      if (programMirrorRecordersRef.current.has(feed.id) || programMirrorStartingRef.current.has(feed.id)) continue;
      const mirrorStream = new MediaStream(feed.stream.getVideoTracks());
      const recorder = new RollingBurstRecorder(mirrorStream, {
        participantId: `program-mirror-${feed.id}`,
        segmentDurationMs: 9_000,
        segmentIntervalMs: 3_000,
        videoBitsPerSecond: 420_000,
        audioBitsPerSecond: 0,
        maxSegmentBytes: 1_500_000,
        maxStoredSegments: 12,
        onError: (error) => setTransportMessage(`Safety capture for ${feed.label}: ${error.message}`),
      });
      const starting = recorder.start()
        .then(async () => {
          const stillLive = feedsRef.current.some((current) =>
            current.id === feed.id && current.stream.getVideoTracks().some((track) => track.readyState === "live"),
          );
          if (!stillLive) {
            await recorder.stop().catch(() => undefined);
            return;
          }
          programMirrorRecordersRef.current.set(feed.id, recorder);
        })
        .catch((error: unknown) => {
          setTransportMessage(error instanceof Error
            ? `Safety capture for ${feed.label}: ${error.message}`
            : `Safety capture for ${feed.label} could not start.`);
        })
        .finally(() => {
          programMirrorStartingRef.current.delete(feed.id);
        });
      programMirrorStartingRef.current.set(feed.id, starting);
    }
  }, [feeds, showLive, stopProgramMirrorRecorders, view]);

  useEffect(() => {
    const video = previewRef.current;
    if (!video || !cameraStream) return;
    return bindResilientPlayback(video, cameraStream, true);
  }, [cameraStream]);

  useEffect(() => {
    if (burstPhase !== "preview") return;
    const timer = window.setTimeout(() => {
      setBurstPhase("preserved");
      if (view === "program") setBurst(null);
    }, 3800);
    return () => window.clearTimeout(timer);
  }, [burstPhase, view]);

  useEffect(() => {
    if (!sessionId || view !== "program" || !convexSessionId) return;
    const nextJoinUrl = `${window.location.origin}/camera?session=${encodeURIComponent(sessionId)}`;
    void QRCode.toDataURL(nextJoinUrl, {
      width: 960,
      margin: 5,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    }).then((dataUrl) => {
      setJoinUrl(nextJoinUrl);
      setQr(dataUrl);
    });
  }, [convexSessionId, sessionId, view]);

  const applyMessage = useCallback((message: WireMessage) => {
    if (message.type === "scene") {
      const delay = Math.max(0, message.scene.cutAt - Date.now());
      window.setTimeout(() => {
        setScene(message.scene);
        setProgramComposition(compositionFromScene(message.scene));
        const mine = message.scene.activeIds.includes(participantIdRef.current);
        setSelectedLive(mine);
        if (mine && navigator.vibrate) navigator.vibrate(36);
      }, delay);
    }
    if (message.type === "session_state") {
      setShowLive(message.state === "live");
      setSessionStatus(message.state);
    }
  }, []);

  useEffect(() => {
    if (!booted || convexInitRef.current) return;
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) {
      queueMicrotask(() => setTransportMessage("Convex realtime is not configured; only local rehearsal is available."));
      return;
    }
    convexInitRef.current = true;
    const client = new ConvexClient(convexUrl);
    convexRef.current = client;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    const subscribe = (slug: string) => {
      unsubscribe?.();
      unsubscribe = client.onUpdate(api.director.programState, { sessionSlug: slug }, (state) => {
        if (cancelled) return;
        serverClockOffsetRef.current = Date.now() - state.serverNowMs;
        setShowLive(state.session.status === "live");
        setSessionStatus(state.session.status);
        if (state.scene) {
          applyMessage({
            type: "scene",
            scene: {
              layout: state.scene.layout,
              activeIds: state.scene.activeParticipantIds.map(String),
              cutAt: state.scene.cutAtServerMs,
              revision: state.scene.revision,
              source: state.scene.source,
              reason: state.scene.reason,
            },
          });
          if (state.scene.reason) {
            if (/\bBURST\b/iu.test(state.scene.reason)) {
              // Old deployments briefly wrote Burst spectacle labels into the
              // persisted director scene. Never resurrect those labels: Burst
              // capture is now completely separate from Program View state.
              setDirectorDecision("MANUAL HOLD · CLICK ANY ANGLE TO SHOW IT LIVE");
            } else {
              const mode = state.scene.source === "ai" ? "OPENAI VISION" : state.scene.source === "manual" ? "MANUAL" : "AI AUTO";
              setDirectorDecision(`${mode} · ${directorReasonLabel(state.scene.reason).toUpperCase()}`);
            }
          }
        }
      }, (error) => setTransportMessage(`Convex realtime error: ${error.message}`));
    };

    void (async () => {
      if (view !== "program") return;
      const stored = window.localStorage.getItem("manyvue-host-session")
        ?? window.localStorage.getItem("crowdcut-host-session");
      let host: HostSession | null = null;
      if (stored) {
        try { host = JSON.parse(stored) as HostSession; } catch { host = null; }
      }
      if (host) {
        try {
          const existing = await client.query(api.sessions.bySlug, { slug: host.slug });
          if (existing.status === "ended" || !existing.publicJoinEnabled) host = null;
        } catch {
          host = null;
        }
      }
      if (!host) {
        window.localStorage.removeItem("manyvue-host-session");
        window.localStorage.removeItem("crowdcut-host-session");
        host = await client.action(api.sessions.create, {
          title: "Outside Lands ManyVue Live",
          festivalName: "Outside Lands",
          stageName: "Hackathon Live",
        }) as HostSession;
        window.localStorage.setItem("manyvue-host-session", JSON.stringify(host));
        window.localStorage.removeItem("crowdcut-host-session");
      }
      if (!host || cancelled) return;
      window.localStorage.setItem("manyvue-host-session", JSON.stringify(host));
      window.localStorage.removeItem("crowdcut-host-session");
      setSessionId(host.slug);
      setConvexSessionId(host.sessionId);
      setHostCapability(host.hostCapability);
      let joined: StoredParticipant | null = null;
      const storedParticipant = window.localStorage.getItem("manyvue-program-participant")
        ?? window.localStorage.getItem("crowdcut-program-participant");
      if (storedParticipant) {
        try {
          const candidate = JSON.parse(storedParticipant) as Partial<StoredParticipant>;
          if (
            candidate.sessionId === host.sessionId &&
            candidate.participantId &&
            candidate.participantCapability &&
            candidate.livekitIdentity
          ) {
            // Validate the stored capability against Convex before reusing it.
            // A normal Program View reload therefore keeps one presenter row
            // instead of creating another presence record every time.
            await client.query(api.participants.me, {
              participantId: candidate.participantId as Id<"participants">,
              participantCapability: candidate.participantCapability,
            });
            joined = candidate as StoredParticipant;
          }
        } catch {
          window.localStorage.removeItem("manyvue-program-participant");
          window.localStorage.removeItem("crowdcut-program-participant");
        }
      }
      if (!joined) {
        joined = await client.action(api.participants.join, {
          sessionSlug: host.slug,
          displayName: "Host angle",
          role: "presenter",
          deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
          shotMetadata: { stageZone: "center", framing: "medium", confidence: 1, source: "self_reported" },
        }) as StoredParticipant;
      }
      if (cancelled) return;
      setParticipantId(String(joined.participantId));
      participantIdRef.current = String(joined.participantId);
      setParticipantCapability(joined.participantCapability);
      window.localStorage.setItem("manyvue-program-participant", JSON.stringify(joined));
      window.localStorage.removeItem("crowdcut-program-participant");
      subscribe(host.slug);
      setTransportMessage("Convex production room ready");
    })().catch((error) => {
      window.localStorage.removeItem("manyvue-host-session");
      window.localStorage.removeItem("crowdcut-host-session");
      setTransport("error");
      setTransportMessage(error instanceof Error ? error.message : "Convex room setup failed.");
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      void client.close();
      convexRef.current = null;
    };
    // Convex owns this lifecycle after the initial URL role is resolved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, view]);

  useEffect(() => {
    const client = convexRef.current;
    if (!client || !participantId || !participantCapability) return;
    return client.onUpdate(api.bursts.recentHistory, {
      participantId: participantId as Id<"participants">,
      participantCapability,
      limit: 24,
    }, (history) => {
      const visible = view === "program"
        ? history.items
        : history.items.filter((item) => item.wasExpected || item.wasInitiator || item.contributed);
      setBurstHistory(visible.map((item) => ({
        id: String(item.burstId),
        at: item.anchorServerMs,
        expectedCount: item.counts.expected,
        readyCount: item.counts.ready,
        status: item.state,
      })));
    }, (error) => {
      if (burstLibraryOpen) setTransportMessage(`Saved Burst history could not sync: ${error.message}`);
    });
  }, [burstLibraryOpen, participantCapability, participantId, view]);

  useEffect(() => {
    if (!sessionId) return;
    const channel = new BroadcastChannel(`manyvue-${sessionId}`);
    channel.onmessage = (event) => applyMessage(event.data as WireMessage);
    channelRef.current = channel;
    return () => channel.close();
  }, [applyMessage, sessionId]);

  const send = useCallback(async (message: WireMessage) => {
    channelRef.current?.postMessage(message);
    const room = roomRef.current;
    if (room?.state === "connected") {
      await room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
        reliable: true,
        topic: "manyvue-control",
      });
    }
  }, []);

  const copyJoinLink = useCallback(async () => {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    setJoinCopied(true);
    window.setTimeout(() => setJoinCopied(false), 1800);
  }, [joinUrl]);

  const createFreshRoom = useCallback(() => {
    window.localStorage.removeItem("manyvue-host-session");
    window.localStorage.removeItem("manyvue-program-participant");
    window.localStorage.removeItem("crowdcut-host-session");
    window.localStorage.removeItem("crowdcut-program-participant");
    window.location.reload();
  }, []);

  const ensureConvexCamera = useCallback(async () => {
    const client = convexRef.current;
    if (!client) return { id: participantId, capability: "", livekitIdentity: participantId };
    let id = participantId;
    let capability = participantCapability;
    let livekitIdentity = participantId;
    if (!capability) {
      let joined: StoredParticipant | null = null;
      const storageKey = `manyvue-camera-${sessionId}`;
      const stored = window.localStorage.getItem(storageKey)
        ?? window.localStorage.getItem(`crowdcut-camera-${sessionId}`);
      if (stored) {
        try {
          const candidate = JSON.parse(stored) as Partial<StoredParticipant>;
          const currentSession = await client.query(api.sessions.bySlug, { slug: sessionId });
          if (
            candidate.sessionId === String(currentSession._id) &&
            candidate.participantId &&
            candidate.participantCapability &&
            candidate.livekitIdentity
          ) {
            await client.query(api.participants.me, {
              participantId: candidate.participantId as Id<"participants">,
              participantCapability: candidate.participantCapability,
            });
            joined = candidate as StoredParticipant;
          }
        } catch {
          joined = null;
        }
      }
      if (!joined) {
        joined = await client.action(api.participants.join, {
          sessionSlug: sessionId,
          displayName: participantName,
          role: "attendee",
          deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
          shotMetadata: {
            stageZone: cameraAngle.toLowerCase() as "left" | "center" | "right",
            framing: "unknown",
            confidence: 1,
            source: "self_reported",
          },
        }) as StoredParticipant;
      }
      id = String(joined.participantId);
      capability = joined.participantCapability;
      livekitIdentity = joined.livekitIdentity;
      setParticipantId(id);
      participantIdRef.current = id;
      setParticipantCapability(capability);
      setConvexSessionId(String(joined.sessionId));
      window.localStorage.setItem(storageKey, JSON.stringify(joined));
      window.localStorage.removeItem(`crowdcut-camera-${sessionId}`);
    }
    // Scene control and Burst capture deliberately use separate subscriptions.
    // This subscription can only update the live production scene.
    convexParticipantUnsubscribeRef.current?.();
    convexParticipantUnsubscribeRef.current = client.onUpdate(api.director.programState, { sessionSlug: sessionId }, (state) => {
      serverClockOffsetRef.current = Date.now() - state.serverNowMs;
      setShowLive(state.session.status === "live");
      setSessionStatus(state.session.status);
      if (state.scene) {
        applyMessage({
          type: "scene",
          scene: {
            layout: state.scene.layout,
            activeIds: state.scene.activeParticipantIds.map(String),
            cutAt: state.scene.cutAtServerMs,
            revision: state.scene.revision,
            source: state.scene.source,
            reason: state.scene.reason,
          },
        });
      }
    });
    return { id, capability, livekitIdentity };
  }, [applyMessage, cameraAngle, participantCapability, participantId, participantName, sessionId]);

  const activateRecordingParticipant = useCallback(async (id: string, capability: string) => {
    const client = convexRef.current;
    if (!client || !capability) return;
    sequenceRef.current += 1;
    await client.mutation(api.participants.beginRecording, {
      participantId: id as Id<"participants">,
      participantCapability: capability,
      clientSequence: sequenceRef.current,
      deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
    });
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    heartbeatRef.current = window.setInterval(() => {
      sequenceRef.current += 1;
      void client.mutation(api.participants.heartbeat, {
        participantId: id as Id<"participants">,
        participantCapability: capability,
        clientSequence: sequenceRef.current,
        connectionState: navigator.onLine ? "online" : "offline",
      });
    }, PRESENCE_HEARTBEAT_MS);
  }, []);

  const registerRoomListeners = useCallback(async (room: LiveRoom, role: "program" | "camera") => {
    const livekit = await import("livekit-client");
    room.on(livekit.RoomEvent.Reconnecting, () => {
      setTransport("connecting");
      setTransportMessage("Reconnecting this camera without interrupting the local recording…");
    });
    room.on(livekit.RoomEvent.Reconnected, () => {
      setTransport("live");
      setTransportMessage("Reconnected to the live camera crew");
    });
    room.on(livekit.RoomEvent.Disconnected, () => {
      setTransport("error");
      setTransportMessage("The live link disconnected. Your local recording remains safe; reconnecting when the network returns.");
    });
    room.on(livekit.RoomEvent.DataReceived, (payload: Uint8Array) => {
      try { applyMessage(JSON.parse(decoder.decode(payload)) as WireMessage); } catch { /* invalid packets are ignored */ }
    });

    const addTrack = (track: { kind: string; mediaStreamTrack: MediaStreamTrack }, participant: { identity: string; name?: string }) => {
      if (track.kind !== livekit.Track.Kind.Video || participant.identity === participantIdRef.current) return;
      setFeeds((current) => {
        const angle = inferStageAngle(participant.identity, participant.name);
        const next: Feed = {
          id: participant.identity,
          angle,
          label: shortCameraLabel(participant.identity, participant.name, angle),
          stream: new MediaStream([track.mediaStreamTrack]),
          joinedAt: current.find((item) => item.id === participant.identity)?.joinedAt ?? Date.now(),
        };
        return [...current.filter((item) => item.id !== next.id), next];
      });
    };
    room.on(livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== livekit.Track.Kind.Video) return;
      // Program and camera clients both receive the real shared cut. The
      // program requests full quality; camera clients retain adaptive quality
      // for a responsive in-hand Live Cuts browser.
      publication.setVideoQuality(role === "program" ? livekit.VideoQuality.HIGH : livekit.VideoQuality.MEDIUM);
      publication.setVideoFPS(role === "program" ? 30 : 24);
      addTrack(track, participant);
    });
    room.on(livekit.RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
      setFeeds((current) => current.filter((feed) => feed.id !== participant.identity));
      setCameraFocusedFeedId((current) => current === participant.identity ? "" : current);
    });
    room.on(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
      setFeeds((current) => current.filter((feed) => feed.id !== participant.identity));
      setCameraFocusedFeedId((current) => current === participant.identity ? "" : current);
    });
    room.on(livekit.RoomEvent.ParticipantNameChanged, (name, participant) => {
      setFeeds((current) => current.map((feed) => {
        if (feed.id !== participant.identity) return feed;
        const angle = inferStageAngle(participant.identity, name);
        return { ...feed, angle, label: shortCameraLabel(participant.identity, name, angle) };
      }));
    });
  }, [applyMessage]);

  const connectTransport = useCallback(async (
    role: "program" | "camera",
    stream?: MediaStream,
    cameraAuthority?: { id: string; capability: string },
  ) => {
    const authorizedParticipantId = cameraAuthority?.id || participantId;
    const authorizedParticipantCapability = cameraAuthority?.capability || participantCapability;
    if (!authorizedParticipantId || !authorizedParticipantCapability || roomRef.current?.state === "connected") return roomRef.current;
    setTransport("connecting");
    setTransportMessage("Connecting the crowd…");
    try {
      const response = await fetch("/api/livekit-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role,
          sessionSlug: sessionId,
          participantId: authorizedParticipantId,
          participantCapability: authorizedParticipantCapability,
          ...(role === "program" ? { sessionId: convexSessionId, hostCapability } : {}),
        }),
      });
      const token = await response.json() as { configured?: boolean; token?: string; url?: string; error?: string };
      if (!response.ok || !token.token || !token.url) {
        setTransport("rehearsal");
        setTransportMessage(token.error || "Live transport needs configuration. This device is recording locally.");
        return null;
      }

      const { Room, Track, VideoPresets } = await import("livekit-client");
      const room = new Room({
        adaptiveStream: false,
        dynacast: true,
        publishDefaults: {
          simulcast: true,
          videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30, priority: "high" },
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          degradationPreference: "balanced",
        },
      });
      await registerRoomListeners(room, role);
      await room.connect(token.url, token.token, { autoSubscribe: true });
      roomRef.current = room;
      if (stream?.getVideoTracks()[0]) {
        await room.localParticipant.publishTrack(stream.getVideoTracks()[0], {
          name: role === "program" ? "host-camera" : "crowd-camera",
          source: Track.Source.Camera,
          simulcast: true,
          videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30, priority: "high" },
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          degradationPreference: "balanced",
        });
      }
      setTransport("live");
      setTransportMessage("Connected to the live camera crew");
      return room;
    } catch (error) {
      setTransport("error");
      setTransportMessage(error instanceof Error ? error.message : "Could not connect to the live room.");
      return null;
    }
  }, [convexSessionId, hostCapability, participantCapability, participantId, registerRoomListeners, sessionId]);

  const buildArtifact = useCallback(async (burstOverride?: { id: string; at: number; count: number }) => {
    const targetBurst = burstOverride ?? ownedBurst;
    if (!targetBurst) {
      setArtifactPhase("saved");
      setArtifactMessage("Your original angle is safe. Tap Burst while recording to create a multi-angle cut.");
      return;
    }
    setUploadState("queued");
    setArtifactPhase("waiting");
    setArtifactMessage(renderIdRef.current
      ? "Checking the production render…"
      : "Waiting for real crowd angles…");
    try {
      let renderId = renderIdRef.current;
      if (!renderId) {
        let candidates = [] as ReturnType<typeof burstEditCandidates>;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const assets = await listBurstAssets(sessionId, targetBurst.id, {
            role: "participant",
            participantId,
            participantCapability,
          });
          candidates = burstEditCandidates(assets, participantId);
          if (candidates.length >= 2 && candidates.some((candidate) => candidate.cameraId === participantId)) break;
          await wait(1_200);
        }
        if (candidates.length < 2 || !candidates.some((candidate) => candidate.cameraId === participantId)) {
          setArtifactPhase("waiting");
          setArtifactMessage("Your Burst angle is uploaded. Waiting for one more real camera — everyone can keep recording.");
          return;
        }
        const editInput = {
          artifactId: `burst-${targetBurst.id}`,
          ownerCameraId: participantId,
          durationMs: 8_000,
          candidates,
        };
        setArtifactPhase("editing");
        setArtifactMessage("AI is directing a personal cut from the real synchronized angles…");
        const plannedResponse = await fetch("/api/ai/edit-recipe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editInput),
        });
        const planned = await plannedResponse.json() as {
          recipe?: unknown;
          fallbackRecipe?: unknown;
          reason?: string;
        };
        const recipe = planned.recipe || planned.fallbackRecipe;
        if (!recipe) throw new Error(planned.reason || "No valid edit recipe was produced.");
        const artifactResponse = await fetch("/api/artifacts/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ editInput, recipe }),
        });
        const queued = await artifactResponse.json() as { state?: string; renderId?: string; reason?: string; missing?: string[] };
        if (!artifactResponse.ok || queued.state !== "queued" || !queued.renderId) {
          setUploadState("failed");
          setArtifactPhase("failed");
          setArtifactMessage(queued.reason || `Production renderer is not ready${queued.missing?.length ? `: ${queued.missing.join(", ")}` : "."}`);
          return;
        }
        renderId = queued.renderId;
        renderIdRef.current = renderId;
      }

      setArtifactPhase("rendering");
      setArtifactMessage("Rendering your real multi-angle ManyVue…");
      for (let attempt = 0; attempt < 14; attempt += 1) {
        await wait(2_000);
        const statusResponse = await fetch(`/api/artifacts/render/status?id=${encodeURIComponent(renderId)}`, { cache: "no-store" });
        const status = await statusResponse.json() as {
          state?: string;
          reason?: string;
          render?: { status?: string; url?: string | null };
        };
        if (!statusResponse.ok) {
          if (status.state === "unconfigured") throw new Error(status.reason || "Production render status is unconfigured.");
          continue;
        }
        if (status.render?.status === "done" && status.render.url) {
          setArtifactUrl(status.render.url);
          setUploadState("uploaded");
          setArtifactPhase("ready");
          setArtifactMessage("Your shareable ManyVue is ready — every angle is real.");
          renderIdRef.current = "";
          return;
        }
        if (status.render?.status === "failed") throw new Error(status.reason || "The production render failed.");
      }
      setArtifactMessage("The production render is still processing. Tap Check render to continue watching it.");
    } catch (error) {
      setUploadState("failed");
      setArtifactPhase("failed");
      setArtifactMessage(error instanceof Error ? error.message : "The cinematic render failed; your original remains safe.");
      renderIdRef.current = "";
    }
  }, [ownedBurst, participantCapability, participantId, sessionId]);

  const promoteCapturedBurst = useCallback(async (
    marker: { id: string; at: number; count: number },
    thumbnailWarning = false,
  ) => {
    setUploadState("uploaded");
    setBurstPhase("preview");
    setArtifactPhase("waiting");
    setArtifactMessage(thumbnailWarning
      ? "Your real Burst clip is uploaded. Waiting for the other synchronized angles…"
      : "Your angle is uploaded. Building your personal multi-angle ManyVue…");
    if (burstArtifactIdsRef.current.has(marker.id)) return;
    burstArtifactIdsRef.current.add(marker.id);
    await buildArtifact(marker);
  }, [buildArtifact]);

  const captureBurstContribution = useCallback(async (sharedBurst: BurstCaptureSignal) => {
    const sharedId = String(sharedBurst._id);
    const marker = { id: sharedId, at: sharedBurst.anchorServerMs, count: sharedBurst.readyContributionCount };
    const initiatedHere = sharedBurst.initiatedHere;
    if (initiatedHere) {
      setBurst(marker);
      setOwnedBurst(marker);
    }
    if (burstCaptureIdsRef.current.has(sharedId)) {
      if (initiatedHere) {
        if (burstCapturedIdsRef.current.has(sharedId)) {
          await promoteCapturedBurst(marker);
        } else {
          window.setTimeout(() => burstCaptureHandlerRef.current(sharedBurst), 300);
        }
      }
      return;
    }
    burstCaptureIdsRef.current.add(sharedId);
    const attempt = (burstCaptureAttemptsRef.current.get(sharedId) ?? 0) + 1;
    burstCaptureAttemptsRef.current.set(sharedId, attempt);
    if (initiatedHere) {
      setBurstPhase("capturing");
      setUploadState("uploading");
      setArtifactPhase("uploading");
      setArtifactMessage("Saving exactly three seconds before and after this Burst while your full camera keeps rolling…");
    }
    try {
      const client = convexRef.current;
      const rolling = rollingBurstRef.current;
      if (!rolling || !client || !participantCapability || !participantId) {
        throw new Error("The rolling Burst buffer is not ready on this camera yet.");
      }
      const localAnchorMs = sharedBurst.anchorServerMs + serverClockOffsetRef.current;
      const capture = await rolling.captureAt(localAnchorMs);
      const localBurstUrl = URL.createObjectURL(capture.blob);
      setLocalBurstAsset((current) => {
        if (current) URL.revokeObjectURL(current.url);
        localBurstUrlRef.current = localBurstUrl;
        return {
          burstId: sharedId,
          url: localBurstUrl,
          extension: capture.blob.type.toLowerCase().includes("mp4") ? "mp4" : "webm",
          durationMs: capture.availableDurationMs,
          burstOffsetMs: capture.burstOffsetMs,
        };
      });
      const durationMs = Math.min(20_000, Math.max(500, Math.round(capture.availableDurationMs)));
      const burstOffsetMs = Math.min(durationMs, Math.max(0, capture.burstOffsetMs));

      await client.mutation(api.bursts.acknowledgePreserved, {
        participantId: participantId as Id<"participants">,
        participantCapability,
        burstId: sharedBurst._id,
        preservedStartMs: Math.max(0, capture.segmentStartedAtMs - recordingStartedRef.current),
        preservedEndMs: Math.max(1, capture.segmentEndedAtMs - recordingStartedRef.current),
      });

      const uploaded = await uploadBurstCaptureAssets({
        session: sessionId,
        participant: participantId,
        access: { role: "participant", participantId, participantCapability },
        burstId: sharedId,
        clip: capture.blob,
        thumbnail: null,
        durationMs,
        burstOffsetMs,
      });
      const clientAssetId = `burst-${sharedId}-${participantId}`;
      await client.mutation(api.assets.registerExternalBurstUpload, {
        participantId: participantId as Id<"participants">,
        participantCapability,
        burstId: sharedBurst._id,
        clientAssetId,
        clipUrl: uploaded.clip.url,
        ...(uploaded.thumbnail?.url ? { thumbnailUrl: uploaded.thumbnail.url } : {}),
        mimeType: capture.blob.type || "video/webm",
        byteLength: capture.blob.size,
        durationMs,
        startsAtServerMs: Math.round(capture.segmentStartedAtMs - serverClockOffsetRef.current),
        endsAtServerMs: Math.round(capture.segmentEndedAtMs - serverClockOffsetRef.current),
      });
      burstCapturedIdsRef.current.add(sharedId);
      burstCaptureAttemptsRef.current.delete(sharedId);
      if (initiatedHere) {
        await promoteCapturedBurst(marker);
      }
      // The playable clip and ready state are the critical path. Contact-sheet
      // extraction can take seconds on Safari, so enrich the same idempotent
      // asset after every angle is already visible in View Bursts.
      void (async () => {
        const sheet = await tryCreateContactSheet(capture.blob, burstOffsetMs);
        if (!sheet.ok) return;
        const enriched = await uploadBurstCaptureAssets({
          session: sessionId,
          participant: participantId,
          access: { role: "participant", participantId, participantCapability },
          burstId: sharedId,
          clip: capture.blob,
          thumbnail: sheet.blob,
          durationMs,
          burstOffsetMs,
        });
        if (!enriched.thumbnail?.url) return;
        await client.mutation(api.assets.registerExternalBurstUpload, {
          participantId: participantId as Id<"participants">,
          participantCapability,
          burstId: sharedBurst._id,
          clientAssetId,
          clipUrl: enriched.clip.url,
          thumbnailUrl: enriched.thumbnail.url,
          mimeType: capture.blob.type || "video/webm",
          byteLength: capture.blob.size,
          durationMs,
          startsAtServerMs: Math.round(capture.segmentStartedAtMs - serverClockOffsetRef.current),
          endsAtServerMs: Math.round(capture.segmentEndedAtMs - serverClockOffsetRef.current),
        });
      })().catch((error: unknown) => {
        console.warn("Deferred Burst contact sheet failed", error);
      });
    } catch (error) {
      burstCaptureIdsRef.current.delete(sharedId);
      if (attempt < 3 && Date.now() <= sharedBurst.windowEndServerMs + serverClockOffsetRef.current + 60_000) {
        window.setTimeout(() => burstCaptureHandlerRef.current(sharedBurst), attempt * 900);
        return;
      }
      burstCaptureAttemptsRef.current.delete(sharedId);
      burstCapturedIdsRef.current.delete(sharedId);
      const reason = error instanceof Error ? error.message : "Burst contribution failed on this camera.";
      console.error("ManyVue Burst contribution failed", { burstId: sharedId, attempt, reason });
      setTransportMessage(`Burst contribution failed: ${reason}`);
      if (initiatedHere) {
        setUploadState("failed");
        setArtifactPhase("failed");
        setArtifactMessage(reason);
        setBurstPhase("idle");
      }
    }
  }, [participantCapability, participantId, promoteCapturedBurst, sessionId]);

  useEffect(() => {
    burstCaptureHandlerRef.current = (sharedBurst) => { void captureBurstContribution(sharedBurst); };
  }, [captureBurstContribution]);

  useEffect(() => {
    const client = convexRef.current;
    if (!client || !recording || !burstBufferReady || !participantId || !participantCapability) return;
    return client.onUpdate(api.bursts.activeCaptureAnchor, {
      participantId: participantId as Id<"participants">,
      participantCapability,
    }, (anchor) => {
      if (!anchor) return;
      burstCaptureHandlerRef.current({
        _id: anchor.burstId,
        anchorServerMs: anchor.anchorServerMs,
        windowStartServerMs: anchor.windowStartServerMs,
        windowEndServerMs: anchor.windowEndServerMs,
        initiatedHere: anchor.initiatedByParticipant,
        readyContributionCount: 0,
      });
    }, (error) => {
      console.error("Silent Burst capture sync failed", error);
    });
  }, [burstBufferReady, participantCapability, participantId, recording]);

  const captureProgramMirrorContribution = useCallback(async (
    sharedBurst: ProgramBurstCaptureSignal,
    targetParticipantId: string,
  ) => {
    const sharedId = String(sharedBurst._id);
    const captureKey = `${sharedId}:${targetParticipantId}`;
    if (programMirrorCapturedRef.current.has(captureKey) || programMirrorInFlightRef.current.has(captureKey)) return;
    const attempt = (programMirrorAttemptsRef.current.get(captureKey) ?? 0) + 1;
    programMirrorAttemptsRef.current.set(captureKey, attempt);
    const recorder = programMirrorRecordersRef.current.get(targetParticipantId);
    const client = convexRef.current;
    if (!recorder || !client || !convexSessionId || !hostCapability) {
      if (attempt < 8 && Date.now() <= sharedBurst.windowEndServerMs + serverClockOffsetRef.current + 60_000) {
        programMirrorInFlightRef.current.add(captureKey);
        window.setTimeout(() => {
          programMirrorInFlightRef.current.delete(captureKey);
          programMirrorHandlerRef.current(sharedBurst);
        }, attempt * 700);
      } else {
        programMirrorAttemptsRef.current.delete(captureKey);
      }
      return;
    }

    programMirrorInFlightRef.current.add(captureKey);
    try {
      const localAnchorMs = sharedBurst.anchorServerMs + serverClockOffsetRef.current;
      const capture = await recorder.captureAt(localAnchorMs);
      const durationMs = Math.min(20_000, Math.max(500, Math.round(capture.availableDurationMs)));
      const burstOffsetMs = Math.min(durationMs, Math.max(0, capture.burstOffsetMs));
      const uploaded = await uploadBurstCaptureAssets({
        session: sessionId,
        participant: targetParticipantId,
        access: {
          role: "host",
          sessionId: convexSessionId,
          hostCapability,
        },
        burstId: sharedId,
        clip: capture.blob,
        thumbnail: null,
        durationMs,
        burstOffsetMs,
      });
      await client.mutation(api.assets.registerExternalBurstUploadByHost, {
        sessionId: convexSessionId as Id<"sessions">,
        hostCapability,
        participantId: targetParticipantId as Id<"participants">,
        burstId: sharedBurst._id,
        clientAssetId: `burst-${sharedId}-${targetParticipantId}`,
        clipUrl: uploaded.clip.url,
        mimeType: capture.blob.type || "video/webm",
        byteLength: capture.blob.size,
        durationMs,
        startsAtServerMs: Math.round(capture.segmentStartedAtMs - serverClockOffsetRef.current),
        endsAtServerMs: Math.round(capture.segmentEndedAtMs - serverClockOffsetRef.current),
      });
      programMirrorCapturedRef.current.add(captureKey);
      programMirrorAttemptsRef.current.delete(captureKey);
    } catch (error) {
      if (attempt < 4 && Date.now() <= sharedBurst.windowEndServerMs + serverClockOffsetRef.current + 60_000) {
        window.setTimeout(() => programMirrorHandlerRef.current(sharedBurst), attempt * 1_200);
      } else {
        programMirrorAttemptsRef.current.delete(captureKey);
        console.error("ManyVue Program mirror contribution failed", {
          burstId: sharedId,
          targetParticipantId,
          attempt,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      programMirrorInFlightRef.current.delete(captureKey);
    }
  }, [convexSessionId, hostCapability, sessionId]);

  useEffect(() => {
    programMirrorHandlerRef.current = (sharedBurst) => {
      for (const targetParticipantId of sharedBurst.expectedParticipantIds.map(String)) {
        void captureProgramMirrorContribution(sharedBurst, targetParticipantId);
      }
    };
  }, [captureProgramMirrorContribution]);

  useEffect(() => {
    const client = convexRef.current;
    if (view !== "program" || !showLive || !client || !convexSessionId || !hostCapability) return;
    return client.onUpdate(api.bursts.activeProgramCaptureAnchor, {
      sessionId: convexSessionId as Id<"sessions">,
      hostCapability,
    }, (anchor) => {
      if (!anchor) return;
      programMirrorHandlerRef.current({
        _id: anchor.burstId,
        anchorServerMs: anchor.anchorServerMs,
        windowStartServerMs: anchor.windowStartServerMs,
        windowEndServerMs: anchor.windowEndServerMs,
        expectedParticipantIds: anchor.expectedParticipantIds,
        initiatedHere: false,
        readyContributionCount: anchor.readyContributionCount,
      });
    }, (error) => {
      console.error("Program mirror Burst sync failed", error);
    });
  }, [convexSessionId, hostCapability, showLive, view]);

  const startCamera = useCallback(async () => {
    if (cameraOpeningRef.current || recording) return;
    cameraOpeningRef.current = true;
    setCameraOpening(true);
    setCameraPermissionState("requesting");
    setTransportMessage("Requesting camera once — Allow immediately joins the live film…");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access requires a current browser on a secure HTTPS page.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          // Ask for the camera sensor's native 4:3 field of view. Forcing 9:16
          // makes several mobile browsers crop the sensor before we ever see
          // the track, which feels zoomed compared with the native camera app.
          width: { ideal: 1280 },
          height: { ideal: 960 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState !== "live") {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("The camera opened without a live video track. Close other camera apps and try again.");
      }
      videoTrack.enabled = true;
      videoTrack.contentHint = "motion";
      setCameraPermissionState("granted");
      window.localStorage.setItem("manyvue-camera-permission", "granted");
      setCameraStream(stream);
      cameraStreamRef.current = stream;
      if (previewRef.current) {
        resumeVideo(previewRef.current, stream, true);
      }

      const convexCamera = await ensureConvexCamera();
      // Attach WebRTC before any local encoder starts. This prevents mobile
      // WebKit from publishing an encoder-starved black camera track.
      await connectTransport("camera", stream, {
        id: convexCamera.id,
        capability: convexCamera.capability,
      });
      const startedAt = Date.now();
      recordingStartedRef.current = startedAt;

      const recorderLease = await createRecorderStreamLease(stream, needsSingleRecorderPipeline());
      recorderStreamReleaseRef.current = recorderLease.release;

      const recorder = new DurableMediaRecorder(recorderLease.stream, {
        recordingId: crypto.randomUUID(),
        participantId: convexCamera.id,
        chunkDurationMs: 1000,
        videoBitsPerSecond: needsSingleRecorderPipeline() ? 560_000 : 4_000_000,
        audioBitsPerSecond: needsSingleRecorderPipeline() ? 48_000 : undefined,
      });
      await recorder.start();
      const rollingBurst = new FrameRingBurstRecorder(stream, {
        participantId: convexCamera.id,
        onError: (error) => setArtifactMessage(`Local Burst recorder: ${error.message}`),
      });
      await rollingBurst.start();
      rollingBurstRef.current = rollingBurst;
      const rollingReadyAt = rollingBurst.readyAtMs;
      if (rollingReadyAt === null) throw new Error("The Burst pre-roll recorder did not start.");
      setCameraStartedAt(startedAt);
      recorderRef.current = recorder;
      setBurstBufferReady(false);
      setTransportMessage("Priming the exact three-second pre-roll…");
      await wait(Math.max(0, rollingReadyAt - Date.now()));
      if (rollingBurstRef.current !== rollingBurst || cameraStreamRef.current !== stream) {
        throw new Error("Camera start was cancelled before the Burst buffer became ready.");
      }
      await activateRecordingParticipant(convexCamera.id, convexCamera.capability);
      setRecording(true);
      setBurstBufferReady(true);
      setTransportMessage("Connected — your full T−3 Burst buffer is ready");
    } catch (error) {
      if (recorderRef.current?.state === "recording") {
        await recorderRef.current.stop().catch(() => undefined);
      }
      recorderRef.current = null;
      await rollingBurstRef.current?.stop().catch(() => undefined);
      rollingBurstRef.current = null;
      recorderStreamReleaseRef.current?.();
      recorderStreamReleaseRef.current = null;
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      setRecording(false);
      setBurstBufferReady(false);
      setTransport("error");
      const blocked = error instanceof DOMException && (
        error.name === "NotAllowedError" || error.name === "SecurityError"
      );
      setCameraPermissionState(blocked ? "blocked" : "error");
      setTransportMessage(blocked
        ? "Camera access is blocked. Enable Camera for this site, then tap Join Camera."
        : error instanceof Error ? error.message : "The camera could not join the live film.");
    } finally {
      cameraOpeningRef.current = false;
      setCameraOpening(false);
    }
  }, [activateRecordingParticipant, connectTransport, ensureConvexCamera, recording]);

  // A QR scan should have one permission decision, not a permission prompt
  // followed by a second artificial "start" step. getUserMedia resolves the
  // same promise after Allow, and the device immediately publishes, records,
  // and primes Burst capture. Returning cameras follow the same path without
  // another application-level confirmation when the browser retained access.
  useEffect(() => {
    if (
      view !== "camera" ||
      !booted ||
      recording ||
      clipUrl ||
      cameraOpeningRef.current ||
      cameraAutoStartAttemptedRef.current
    ) return;
    cameraAutoStartAttemptedRef.current = true;
    const timer = window.setTimeout(() => void startCamera(), 0);
    return () => window.clearTimeout(timer);
  }, [booted, clipUrl, recording, startCamera, view]);

  const stopCamera = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      const result = await recorder.stop();
      const localUrl = URL.createObjectURL(result.blob);
      setClipExtension(result.blob.type.toLowerCase().includes("mp4") ? "mp4" : "webm");
      setClipUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        clipUrlRef.current = localUrl;
        return localUrl;
      });
      setUploadState((current) => current === "idle" ? "queued" : current);
      setArtifactPhase((current) => current === "idle" ? "saved" : current);
      setArtifactMessage((current) => current || "Your complete original is saved on this device and ready to download.");
    }
    await rollingBurstRef.current?.stop().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The rolling Burst buffer could not stop cleanly.");
    });
    rollingBurstRef.current = null;
    recorderRef.current = null;
    recorderStreamReleaseRef.current?.();
    recorderStreamReleaseRef.current = null;
    setRecording(false);
    setBurstBufferReady(false);
    setSelectedLive(false);
    if (convexRef.current && participantCapability) {
      sequenceRef.current += 1;
      await convexRef.current.mutation(api.participants.stopRecording, {
        participantId: participantId as Id<"participants">,
        participantCapability,
        clientSequence: sequenceRef.current,
      }).catch(() => undefined);
    }
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    convexParticipantUnsubscribeRef.current?.();
    await roomRef.current?.disconnect();
    roomRef.current = null;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraStream(null);
  }, [cameraStream, participantCapability, participantId]);

  useEffect(() => {
    if (view !== "camera" || sessionStatus !== "ended" || !recording) return;
    const timer = window.setTimeout(() => {
      setTransportMessage("The host stopped the film. Saving your complete local recording now…");
      void stopCamera();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [recording, sessionStatus, stopCamera, view]);

  const triggerBurst = useCallback(async () => {
    const hostCanCue = view === "program" && showLive && feedsRef.current.some((feed) => !feed.local);
    const hostAngleReady = !feedsRef.current.some((feed) => feed.local) || burstBufferReady;
    if (
      burstPending ||
      (view === "camera" && (!recording || !burstBufferReady)) ||
      (view === "program" && (!hostCanCue || !hostAngleReady))
    ) return;
    setBurstPending(true);
    const markerId = crypto.randomUUID();
    const clickedAt = Date.now();
    setBurstPhase("capturing");
    setLastBurstCount(0);
    try {
      if (navigator.vibrate) navigator.vibrate([32, 24, 64]);
      if (convexRef.current && participantCapability) {
        const result = view === "program" && convexSessionId && hostCapability
          ? await convexRef.current.mutation(api.bursts.triggerByHost, {
              sessionId: convexSessionId as Id<"sessions">,
              hostCapability,
              actorParticipantId: participantId as Id<"participants">,
              clientMarkerId: markerId,
              clientObservedAtMs: clickedAt,
            })
          : await convexRef.current.mutation(api.bursts.trigger, {
              participantId: participantId as Id<"participants">,
              participantCapability,
              clientMarkerId: markerId,
              clientObservedAtMs: clickedAt,
            });
        if (result.burst) {
          const marker = { id: String(result.burst._id), at: result.burst.anchorServerMs, count: result.burst.readyContributionCount };
          setBurst(marker);
          setLastBurstCount(marker.count);
          if (view === "camera") setOwnedBurst(marker);
          if (result.burst.expectedParticipantIds.map(String).includes(participantId)) {
            burstCaptureHandlerRef.current({
              _id: result.burst._id,
              anchorServerMs: result.burst.anchorServerMs,
              windowStartServerMs: result.burst.windowStartServerMs,
              windowEndServerMs: result.burst.windowEndServerMs,
              initiatedHere: true,
              readyContributionCount: result.burst.readyContributionCount,
            });
          }
        }
        return;
      }
      throw new Error("Convex realtime is required to synchronize and save a Burst across cameras.");
    } catch (error) {
      setBurstPhase("idle");
      setTransportMessage(error instanceof Error ? error.message : "Crowd Burst could not be captured.");
      if (navigator.vibrate) navigator.vibrate([90, 45, 90]);
    } finally {
      setBurstPending(false);
    }
  }, [burstBufferReady, burstPending, convexSessionId, hostCapability, participantCapability, participantId, recording, showLive, view]);

  const commitScene = useCallback(async (
    activeIds: string[],
    layout: SceneLayout,
    reason?: string,
    sourceOverride?: "manual" | "deterministic" | "ai",
  ) => {
    const issuedAt = Date.now();
    const source = sourceOverride ?? (reason?.startsWith("Manual") ? "manual" : directorAuto ? "ai" : "manual");
    const sceneReason = reason ?? (directorAuto ? "Stage-aware deterministic AI direction" : "Presenter live view");
    const next: Scene = {
      layout,
      activeIds,
      cutAt: issuedAt + 600,
      revision: issuedAt,
      source,
      reason: sceneReason,
    };
    if (convexRef.current && convexSessionId && hostCapability && activeIds.length) {
      await convexRef.current.mutation(api.director.scheduleScene, {
        sessionId: convexSessionId as Id<"sessions">,
        hostCapability,
        layout,
        activeParticipantIds: activeIds.map((id) => id as Id<"participants">),
        cutAtServerMs: next.cutAt,
        source,
        reason: sceneReason,
        idempotencyKey: `scene-${next.revision}-${next.cutAt}`,
      });
      return;
    }
    applyMessage({ type: "scene", scene: next });
    await send({ type: "scene", scene: next });
  }, [applyMessage, convexSessionId, directorAuto, hostCapability, send]);

  const startProgram = useCallback(async () => {
    if (showLive || programStarting) return;
    if (!participantId || (process.env.NEXT_PUBLIC_CONVEX_URL && (!convexSessionId || !hostCapability))) {
      setTransportMessage("Preparing the production room — START FILM will unlock automatically.");
      return;
    }
    setProgramStarting(true);
    setTransportMessage("Opening the live Program View…");
    try {
      await connectTransport("program");
      if (convexRef.current && convexSessionId && hostCapability) {
        await convexRef.current.mutation(api.sessions.startLive, {
          sessionId: convexSessionId as Id<"sessions">,
          hostCapability,
        });
      }
      setShowLive(true);
      setSessionStatus("live");
      setElapsed(0);
      setDirectorDecision(feedsRef.current.length
        ? "MANUAL HOLD · CLICK ANY ANGLE TO SHOW IT LIVE"
        : "MANUAL HOLD · WAITING FOR FIRST CAMERA");
      await send({ type: "session_state", state: "live" });
    } catch (error) {
      setTransportMessage(error instanceof Error ? error.message : "The live film could not start.");
    } finally {
      setProgramStarting(false);
    }
  }, [connectTransport, convexSessionId, hostCapability, participantId, programStarting, send, showLive]);

  useEffect(() => {
    const isDedicatedProgramEntry = window.location.pathname === "/program";
    const realtimeReady = !process.env.NEXT_PUBLIC_CONVEX_URL || Boolean(convexSessionId && hostCapability);
    if (
      !isDedicatedProgramEntry ||
      view !== "program" ||
      !booted ||
      !participantId ||
      !realtimeReady ||
      showLive ||
      programStarting ||
      programAutoStartAttemptedRef.current
    ) return;

    programAutoStartAttemptedRef.current = true;
    setJoinExpanded(true);
    void startProgram();
  }, [booted, convexSessionId, hostCapability, participantId, programStarting, showLive, startProgram, view]);

  const stopProgram = useCallback(async () => {
    if (!showLive || programStopping) return;
    setProgramStopping(true);
    setTransportMessage("Stopping the live film and safely closing every camera…");
    try {
      if (convexRef.current && convexSessionId && hostCapability) {
        await convexRef.current.mutation(api.sessions.endLive, {
          sessionId: convexSessionId as Id<"sessions">,
          hostCapability,
        });
      }
      await send({ type: "session_state", state: "ended" });
      sweepTokenRef.current += 1;
      setDirectorAuto(false);
      await rollingBurstRef.current?.stop().catch(() => undefined);
      rollingBurstRef.current = null;
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      setRecording(false);
      setBurstBufferReady(false);
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      await roomRef.current?.disconnect();
      roomRef.current = null;
      setFeeds([]);
      setSelectedCameraIds([]);
      setJoinExpanded(true);
      setScene({ layout: "hero", activeIds: [], cutAt: 0, revision: Date.now() });
      setProgramComposition(1);
      setShowLive(false);
      setSessionStatus("ended");
      setDirectorDecision("FILM ENDED · EVERY SAVED BURST REMAINS AVAILABLE");
      setTransportMessage("Film stopped. Start a new room whenever you are ready.");
    } catch (error) {
      setTransportMessage(error instanceof Error ? error.message : "The live film could not be stopped safely.");
    } finally {
      setProgramStopping(false);
    }
  }, [convexSessionId, hostCapability, programStopping, send, showLive]);

  const publishHostAngle = useCallback(async () => {
    if (hostPublishing || feedsRef.current.some((feed) => feed.local)) return;
    setHostPublishing(true);
    let stream: MediaStream | null = null;
    try {
      if (!showLive) await startProgram();
      setTransportMessage("Opening this computer's optional host camera…");
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: false,
      });
      setCameraStream(stream);
      cameraStreamRef.current = stream;
      const room = await connectTransport("program");
      if (room) {
        const { Track, VideoPresets } = await import("livekit-client");
        await room.localParticipant.publishTrack(stream.getVideoTracks()[0], {
          name: "host-camera",
          source: Track.Source.Camera,
          simulcast: true,
          videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30, priority: "high" },
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          degradationPreference: "balanced",
        });
      }
      const startedAt = Date.now();
      recordingStartedRef.current = startedAt;
      const host: Feed = {
        id: participantId,
        angle: "CENTER",
        label: "HOST",
        stream,
        local: true,
        joinedAt: Date.now(),
      };
      setFeeds((current) => [...current.filter((feed) => feed.id !== host.id), host]);
      setScene({
        layout: "hero",
        activeIds: [host.id],
        cutAt: Date.now(),
        revision: Date.now(),
        source: "manual",
        reason: "Host camera published",
      });
      setProgramComposition(1);
      setDirectorDecision("MANUAL · HOST ANGLE LIVE");
      setCameraStartedAt(startedAt);
      setBurstBufferReady(false);
      setTransportMessage("Host angle is live — adding it to realtime production control…");

      setRecording(true);
      try {
        if (convexRef.current && participantCapability) {
          await convexRef.current.mutation(api.participants.updateShotMetadata, {
            participantId: participantId as Id<"participants">,
            participantCapability,
            shotMetadata: { stageZone: "center", framing: "medium", confidence: 1, source: "self_reported" },
          });
          await activateRecordingParticipant(participantId, participantCapability);
        }
        await commitScene([host.id], "hero", "Host camera published", "manual");
      } catch (error) {
        setTransportMessage(error instanceof Error
          ? `Host angle is visible; shared scene sync is retrying: ${error.message}`
          : "Host angle is visible; shared scene sync is retrying.");
      }

      try {
        const hostBurstRecorder = new FrameRingBurstRecorder(stream, {
          participantId,
          onError: (error) => setTransportMessage(`Host angle is live; local Burst capture: ${error.message}`),
        });
        await hostBurstRecorder.start();
        rollingBurstRef.current = hostBurstRecorder;
        const readyAt = hostBurstRecorder.readyAtMs;
        if (readyAt === null) throw new Error("Host Burst pre-roll did not start.");
        setTransportMessage("Host angle is live — priming its local T−3 frame ring…");
        await wait(Math.max(0, readyAt - Date.now()));
        if (rollingBurstRef.current !== hostBurstRecorder || cameraStreamRef.current !== stream) {
          throw new Error("Host Burst priming was interrupted.");
        }
        setBurstBufferReady(true);
        setTransportMessage("Host angle is live and contributes its own local Burst source.");
      } catch (error) {
        setBurstBufferReady(false);
        setTransportMessage(error instanceof Error
          ? `Host angle is live; local Burst capture is unavailable: ${error.message}`
          : "Host angle is live; local Burst capture is unavailable.");
      }
    } catch (error) {
      await rollingBurstRef.current?.stop().catch(() => undefined);
      rollingBurstRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      setRecording(false);
      setBurstBufferReady(false);
      setFeeds((current) => current.filter((feed) => !feed.local));
      setTransportMessage(error instanceof Error ? error.message : "Host camera could not start.");
    } finally {
      setHostPublishing(false);
    }
  }, [activateRecordingParticipant, commitScene, connectTransport, hostPublishing, participantCapability, participantId, showLive, startProgram]);

  useEffect(() => {
    if (!showLive) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [showLive]);

  const orderedFeeds = useMemo(() => orderedByStage(feeds), [feeds]);
  const selectedFeeds = useMemo(() => selectedCameraIds.flatMap((id) => {
    const feed = feeds.find((candidate) => candidate.id === id);
    return feed ? [feed] : [];
  }).slice(0, 5), [feeds, selectedCameraIds]);

  const toggleCameraSelection = useCallback((feed: Feed) => {
    const connected = selectedCameraIds.filter((id) => feeds.some((candidate) => candidate.id === id));
    if (connected.includes(feed.id)) {
      setSelectedCameraIds(connected.filter((id) => id !== feed.id));
      return;
    }
    if (connected.length >= 5) {
      setTransportMessage("Five angles are already selected. Deselect one before adding another.");
      return;
    }
    setSelectedCameraIds([...connected, feed.id]);
  }, [feeds, selectedCameraIds]);

  const takeFeed = useCallback((feed: Feed) => {
    sweepTokenRef.current += 1;
    setMobileWallOpen(false);
    setDirectorAuto(false);
    setDirectorDecision(`SHOWING LIVE · ${feed.angle} · ${feed.label}`);
    void (async () => {
      if (!showLive) await startProgram();
      await commitScene(
        [feed.id],
        "hero",
        `Showing the ${feed.angle.toLowerCase()} stage angle full screen`,
      );
    })().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The live angle could not be shown.");
    });
  }, [commitScene, showLive, startProgram]);

  const takeSelectedLayout = useCallback((count: 1 | 2 | 3 | 4 | 5) => {
    const chosen = selectedFeeds.slice(0, count);
    if (chosen.length < count) {
      setTransportMessage(`Select ${count} live ${count === 1 ? "camera" : "cameras"} in Multiview first.`);
      return;
    }
    sweepTokenRef.current += 1;
    setMobileWallOpen(false);
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL ${count}-ANGLE COMPOSITION · ${chosen.map((feed) => feed.angle).join(" + ")}`);
    void (async () => {
      if (!showLive) await startProgram();
      await commitScene(
        chosen.map((feed) => feed.id),
        count === 1 ? "hero" : count === 2 ? "duo" : "sweep",
        `Manual ${count}-angle GRID · ${chosen.map((feed) => `${feed.angle} ${feed.label}`).join(" + ")}`,
      );
    })().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : `The ${count}-angle composition failed.`);
    });
  }, [commitScene, selectedFeeds, showLive, startProgram]);

  const takeSweep = useCallback(() => {
    const sweep = selectedFeeds.slice(0, 5);
    if (sweep.length < 2) {
      setTransportMessage("Select at least two live cameras before running a SWEEP.");
      return;
    }
    const sweepToken = ++sweepTokenRef.current;
    setMobileWallOpen(false);
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL SWEEP · ${sweep.map((feed) => feed.angle).join(" → ")}`);
    void (async () => {
      if (!showLive) await startProgram();
      await commitScene(
        sweep.map((feed) => feed.id),
        sweep.length > 1 ? "sweep" : "hero",
        `Manual stage-relative SWEEP: ${sweep.map((feed) => feed.angle).join(" → ")}`,
      );
      if (sweep.length <= 1) return;
      const landingHero = pickAngle(sweep, "CENTER", 0) ?? sweep[sweep.length - 1];
      window.setTimeout(() => {
        if (sweepTokenRef.current !== sweepToken) return;
        setDirectorDecision(`MANUAL LAND · ${landingHero.angle} · ${landingHero.label}`);
        void commitScene(
          [landingHero.id],
          "hero",
          `Manual SWEEP landed deliberately on ${landingHero.angle.toLowerCase()} hero`,
        ).catch((error) => setTransportMessage(error instanceof Error ? error.message : "The SWEEP landing failed."));
      }, 2_300 + (sweep.length - 1) * PRODUCTION_SWEEP_STAGGER_MS);
    })().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The live angle sweep failed.");
    });
  }, [commitScene, selectedFeeds, showLive, startProgram]);

  const toggleDirectorAuto = useCallback(() => {
    sweepTokenRef.current += 1;
    const next = !directorAuto;
    setDirectorAuto(next);
    setDirectorDecision(
      next ? "AI AUTO · STAGE-AWARE ROTATION" : "MANUAL HOLD · CLICK ANY ANGLE TO SHOW IT LIVE",
    );
  }, [directorAuto]);

  useEffect(() => {
    if (view !== "program" || !showLive || !directorAuto || burst) return;
    const directNow = () => {
      const currentFeeds = feedsRef.current;
      if (currentFeeds.length === 0) {
        setDirectorDecision("AI AUTO · WAITING FOR A LIVE CAMERA");
        return;
      }
      if (convexRef.current && convexSessionId && hostCapability) {
        setDirectorDecision("AI AUTO · CONVEX IS DIRECTING THE ROOM…");
        void convexRef.current.mutation(api.director.scheduleAutoScene, {
          sessionId: convexSessionId as Id<"sessions">,
          hostCapability,
          cutAtServerMs: Date.now() + 700,
          idempotencyKey: `auto-${Date.now()}-${directorStepRef.current++}`,
        }).then((directed) => {
          if (directed?.reason) setDirectorDecision(`AI AUTO · ${directed.reason.toUpperCase()}`);
        }).catch((error) => {
          setTransportMessage(error instanceof Error ? error.message : "The automatic camera cut failed.");
        });
        return;
      }
      const directed = stageAwareDirectorScene(currentFeeds, directorStepRef.current);
      directorStepRef.current += 1;
      if (!directed.feeds.length) return;
      setDirectorDecision(`AI AUTO · ${directed.decision}`);
      void commitScene(
        directed.feeds.map((feed) => feed.id),
        directed.layout,
        `Stage-aware AI AUTO: ${directed.decision}`,
      ).catch((error) => {
        setTransportMessage(error instanceof Error ? error.message : "The automatic camera cut failed.");
      });
    };
    // Show the first live angle immediately when AUTO is enabled; subsequent cuts follow the
    // predictable production cadence. A presenter should never click AUTO
    // and wonder whether anything happened.
    directNow();
    const timer = window.setInterval(directNow, AUTO_CADENCE_MS);
    return () => window.clearInterval(timer);
  }, [burst, commitScene, convexSessionId, directorAuto, hostCapability, showLive, view]);

  useEffect(() => {
    if (view !== "program" || burstPhase !== "capturing" || !burst) return;
    const saved = burstHistory.find((entry) => entry.id === burst.id);
    if (!saved?.readyCount) return;
    queueMicrotask(() => {
      setLastBurstCount(saved.readyCount);
      setBurstPhase("preview");
      setDirectorDecision(`BURST SAVED · ${saved.readyCount}/${saved.expectedCount} ANGLES READY`);
    });
  }, [burst, burstHistory, burstPhase, view]);

  useEffect(() => {
    const crowdCount = feeds.filter((feed) => !feed.local).length;
    if (view === "program" && previousCrowdCameraCountRef.current === 0 && crowdCount > 0) {
      setJoinExpanded(false);
    }
    previousCrowdCameraCountRef.current = crowdCount;
  }, [feeds, view]);

  useEffect(() => () => {
    roomRef.current?.disconnect();
    void rollingBurstRef.current?.stop();
    void stopProgramMirrorRecorders();
    recorderStreamReleaseRef.current?.();
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    if (localBurstUrlRef.current) URL.revokeObjectURL(localBurstUrlRef.current);
  }, [stopProgramMirrorRecorders]);

  const activeFeeds = useMemo(() => {
    const selected = scene.activeIds.map((id) => feeds.find((feed) => feed.id === id)).filter(Boolean) as Feed[];
    const directedFallback = stageAwareDirectorScene(orderedFeeds, 0).feeds;
    return selected.length
      ? selected
      : directedFallback.slice(0, scene.layout === "duo" ? 2 : 1);
  }, [feeds, orderedFeeds, scene.activeIds, scene.layout]);

  const multiviewActive = programComposition !== 1 && activeFeeds.length > 1;

  const launchSelectedMultiview = useCallback(() => {
    const count = Math.min(5, selectedFeeds.length);
    if (count < 2) {
      setTransportMessage("Select at least two live cameras, then launch Multiview.");
      return;
    }
    takeSelectedLayout(count as 2 | 3 | 4 | 5);
  }, [selectedFeeds.length, takeSelectedLayout]);

  const exitMultiview = useCallback(() => {
    const hero = activeFeeds[0] ?? selectedFeeds[0] ?? orderedFeeds[0];
    if (!hero) {
      setTransportMessage("A live camera is required before leaving Multiview.");
      return;
    }
    takeFeed(hero);
  }, [activeFeeds, orderedFeeds, selectedFeeds, takeFeed]);

  const cameraBrowseFeeds = useMemo(() => {
    const mine = cameraStream ? {
      id: participantId,
      angle: cameraAngle,
      label: "MY ANGLE",
      stream: cameraStream,
      local: true,
      joinedAt: cameraStartedAt,
    } satisfies Feed : undefined;
    return distinctFeeds([mine], orderedFeeds);
  }, [cameraAngle, cameraStartedAt, cameraStream, orderedFeeds, participantId]);

  const cameraFocusedFeed = useMemo(
    () => cameraBrowseFeeds.find((feed) => feed.id === cameraFocusedFeedId),
    [cameraBrowseFeeds, cameraFocusedFeedId],
  );

  const hostAnglePublished = feeds.some((feed) => feed.local);
  const hostBurstWarming = hostAnglePublished && !burstBufferReady;
  const crowdCameraCount = feeds.filter((feed) => !feed.local).length;
  const programRoomReady = booted && Boolean(participantId) && (
    !process.env.NEXT_PUBLIC_CONVEX_URL || Boolean(convexSessionId && hostCapability)
  );
  const artifactUploadDone = (["waiting", "editing", "rendering", "ready"] as ArtifactPhase[]).includes(artifactPhase);
  const artifactEditDone = (["rendering", "ready"] as ArtifactPhase[]).includes(artifactPhase);
  const ownedBurstHistory = ownedBurst ? burstHistory.find((entry) => entry.id === ownedBurst.id) : undefined;
  const programBurstHistory = burst ? burstHistory.find((entry) => entry.id === burst.id) : undefined;

  if (view === "camera") {
    return (
      <main className={`camera-shell ${selectedLive ? "is-live" : ""}`}>
        <video
          ref={previewRef}
          className={`camera-preview ${recording && cameraViewMode === "live" ? "is-hidden" : ""}`}
          autoPlay
          muted
          playsInline
          disablePictureInPicture
          onLoadedMetadata={(event) => {
            const stream = cameraStreamRef.current;
            if (stream) resumeVideo(event.currentTarget, stream, true);
          }}
        />
        {recording && cameraViewMode === "live" && (
          <section className={`camera-live-browser ${cameraFocusedFeed ? "is-focused" : "is-gallery"}`} aria-label="Live Cuts angle viewer">
            {cameraFocusedFeed ? (
              <>
                <div className="camera-live-focus">
                  <FeedVideo feed={cameraFocusedFeed} />
                  <div className="camera-live-focus-label">
                    <span>PRIVATE LIVE VIEW · DOES NOT CHANGE THE PROGRAM</span>
                    <b>{cameraFocusedFeed.angle} · {cameraFocusedFeed.label}</b>
                  </div>
                </div>
                <div className="camera-live-focus-actions">
                  <button className="camera-live-back" type="button" onClick={() => setCameraFocusedFeedId("")}>← ALL LIVE CUTS</button>
                  <button className="camera-live-mine" type="button" onClick={() => { setCameraViewMode("mine"); setCameraFocusedFeedId(""); }}>RETURN TO MY ANGLE</button>
                </div>
              </>
            ) : (
              <div className="camera-live-gallery-wrap">
                <header>
                  <div><p className="eyebrow">LIVE CUTS</p><h2>Every connected angle.</h2></div>
                  <div className="camera-live-gallery-actions">
                    <span>{cameraBrowseFeeds.length} LIVE · TAP ANY VIEW</span>
                    <button type="button" onClick={() => { setCameraViewMode("mine"); setCameraFocusedFeedId(""); }}>← MY ANGLE</button>
                  </div>
                </header>
                <div className="camera-live-gallery">
                  {cameraBrowseFeeds.map((feed) => {
                    const onAir = scene.activeIds.includes(feed.id);
                    return (
                      <button
                        type="button"
                        className={`camera-live-angle angle-${feed.angle.toLowerCase()} ${onAir ? "on-air" : ""}`}
                        key={feed.id}
                        onClick={() => setCameraFocusedFeedId(feed.id)}
                        aria-label={`Privately view ${feed.label} live`}
                      >
                        <span className="camera-live-angle-video"><FeedVideo feed={feed} /></span>
                        <span className="camera-live-angle-meta">
                          <b>{feed.angle} · {feed.label}</b>
                          <em>{onAir ? "ON PROGRAM" : "VIEW LIVE →"}</em>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="camera-live-private-note">Your browsing is private. Tapping an angle never changes the shared film.</p>
              </div>
            )}
          </section>
        )}
        {!cameraStream && <div className="camera-aurora" aria-hidden="true" />}
        <header className="camera-topbar">
          <BrandMark />
          <StatusPill tone={selectedLive ? "live" : recording ? "ready" : "warn"}>
            {selectedLive ? "YOUR ANGLE IS LIVE" : recording ? "RECORDING" : "READY"}
          </StatusPill>
        </header>

        {recording && (
          <div className="camera-view-toggle" role="group" aria-label="Choose camera monitor">
            <button className={cameraViewMode === "mine" ? "selected" : ""} onClick={() => { setCameraViewMode("mine"); setCameraFocusedFeedId(""); }}>MY ANGLE ↩</button>
            <button className={cameraViewMode === "live" ? "selected" : ""} onClick={() => { setCameraViewMode("live"); setCameraFocusedFeedId(""); }}>
              LIVE CUTS <b>{cameraBrowseFeeds.length}</b><i aria-hidden="true" />
            </button>
            <button className="view-bursts-toggle" onClick={() => setBurstLibraryOpen(true)}>
              BURSTS <b>{burstHistory.length}</b>
            </button>
          </div>
        )}

        <BurstExperience
          phase={burstPhase}
          count={Math.max(lastBurstCount, ownedBurstHistory?.readyCount ?? 0, ownedBurst?.count ?? burst?.count ?? 0)}
          total={ownedBurstHistory?.expectedCount ?? Math.max(cameraBrowseFeeds.length, 1)}
        />

        {!recording && !clipUrl && (
          <section className="camera-intro">
            <p className="eyebrow">ONE PERMISSION · IMMEDIATE LIVE ANGLE</p>
            <h1>{cameraPermissionState === "blocked" ? "Camera access is blocked." : "Allow once.\n"}<em>{cameraPermissionState === "blocked" ? "Rejoin instantly." : "You are in."}</em></h1>
            <p>After Camera permission is allowed, ManyVue immediately records and publishes your angle—there is no second start step. Your mic stays only in your personal recording and is never mixed into the room.</p>
            <div className="stage-angle-picker" role="group" aria-label="Choose your position relative to the stage">
              <div>
                <b>WHERE ARE YOU?</b>
                <span>Face the stage, then tap your side</span>
              </div>
              <div className="stage-angle-options">
                {STAGE_ANGLES.map((angle) => (
                  <button
                    type="button"
                    key={angle}
                    className={cameraAngle === angle ? "selected" : ""}
                    aria-pressed={cameraAngle === angle}
                    onClick={() => chooseCameraAngle(angle)}
                  >
                    <i aria-hidden="true" />
                    {angle}
                  </button>
                ))}
              </div>
              <small>The director uses this to cut between genuinely different views.</small>
            </div>
            {(cameraPermissionState === "blocked" || cameraPermissionState === "error") ? (
              <button className="record-trigger" onClick={startCamera} disabled={cameraOpening}>
                <span aria-hidden="true" /> {cameraOpening ? "RECONNECTING…" : "JOIN CAMERA"}
              </button>
            ) : (
              <div className="camera-auto-join" role="status" aria-live="polite">
                <i aria-hidden="true" />
                <div><b>{cameraPermissionState === "granted" ? "PERMISSION GRANTED" : "ALLOW CAMERA TO JOIN"}</b><span>Camera → live angle → rolling Burst buffer, automatically</span></div>
              </div>
            )}
            {transportMessage && <p className="inline-message">{transportMessage}</p>}
          </section>
        )}

        {recording && (
          <section className="camera-controls">
            <div className="recording-readout"><i /> {cameraAngle} ANGLE · VIDEO LIVE · MIC LOCAL <b>{String(elapsed).padStart(2, "0")}s</b></div>
            <div className="recording-angle-picker" role="group" aria-label="Update your position relative to the stage">
              {STAGE_ANGLES.map((angle) => (
                <button key={angle} type="button" className={cameraAngle === angle ? "selected" : ""} onClick={() => chooseCameraAngle(angle)}>{angle}</button>
              ))}
            </div>
            <button className={`burst-trigger ${ownedBurst ? "caught" : ""}`} onClick={triggerBurst} disabled={burstPending || !burstBufferReady}>
              <span className="burst-rings" aria-hidden="true"><i /><i /></span>
              <b>{!burstBufferReady ? "CHARGING 3-SECOND PRE-ROLL…" : burstPending ? "SAVING T−3 → T+3…" : ownedBurst ? "BURST SAVED · TAP FOR ANOTHER" : "BURST THIS MOMENT"}</b>
              <small>{ownedBurst ? `${Math.max(1, ownedBurst.count)} saved angles · open View Bursts` : "Instant tap — no countdown, your full recording keeps running"}</small>
            </button>
            {burstPhase === "preserved" && ownedBurst && (
              <p className="camera-burst-preserved"><b>BURST PRESERVED</b> Your synchronized angle uploads now while the full recording continues uninterrupted.</p>
            )}
            {localBurstAsset && (
              <a
                className="camera-local-burst-download"
                href={localBurstAsset.url}
                download={`my-local-manyvue-burst.${localBurstAsset.extension}`}
              >DOWNLOAD MY LOCAL BURST</a>
            )}
            <button className="stop-trigger" onClick={stopCamera}>Stop & build my ManyVue</button>
            {transportMessage && <p className="inline-message camera-inline-message">{transportMessage}</p>}
          </section>
        )}

        {clipUrl && !recording && (
          <section className="artifact-card">
            <p className="eyebrow">YOUR MOMENT IS REAL</p>
            <h2>{artifactUrl ? "Your ManyVue is ready." : "Your angle is safe."}</h2>
            <div className={`artifact-pipeline phase-${artifactPhase}`} aria-label="ManyVue artifact progress">
              <span className="complete"><i />SAVED</span>
              <span className={artifactUploadDone ? "complete" : artifactPhase === "uploading" ? "active" : ""}><i />UPLOAD</span>
              <span className={artifactEditDone ? "complete" : (["waiting", "editing"] as ArtifactPhase[]).includes(artifactPhase) ? "active" : ""}><i />AI CUT</span>
              <span className={artifactPhase === "ready" ? "complete" : artifactPhase === "rendering" ? "active" : ""}><i />RENDER</span>
              <span className={artifactPhase === "ready" ? "active" : ""}><i />DOWNLOAD</span>
            </div>
            <video src={artifactUrl || clipUrl} controls playsInline />
            <div className="artifact-actions">
              <a href={artifactUrl || clipUrl} download={artifactUrl ? "my-manyvue.mp4" : `my-angle.${clipExtension}`}>{artifactUrl ? "DOWNLOAD MANYVUE" : "DOWNLOAD MY ANGLE"}</a>
              {localBurstAsset && (
                <a href={localBurstAsset.url} download={`my-local-manyvue-burst.${localBurstAsset.extension}`}>
                  DOWNLOAD LOCAL BURST
                </a>
              )}
              {ownedBurst && !artifactUrl && (["waiting", "failed", "rendering"] as ArtifactPhase[]).includes(artifactPhase) && (
                <button onClick={() => void buildArtifact()}>
                  {artifactPhase === "rendering" ? "CHECK RENDER" : artifactPhase === "waiting" ? "RETRY MULTI-ANGLE BUILD" : "BUILD FROM REAL ANGLES"}
                </button>
              )}
              <button onClick={() => {
                if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
                clipUrlRef.current = "";
                setClipUrl("");
                setArtifactUrl("");
                setArtifactMessage("");
                setBurst(null);
                setOwnedBurst(null);
                setUploadState("idle");
                setArtifactPhase("idle");
                setBurstPhase("idle");
                setLocalBurstAsset((current) => {
                  if (current) URL.revokeObjectURL(current.url);
                  localBurstUrlRef.current = "";
                  return null;
                });
                renderIdRef.current = "";
              }}>Record another</button>
            </div>
            <p className={`upload-state ${uploadState}`}>{artifactMessage || (uploadState === "uploading" ? "Uploading the real source…" : uploadState === "failed" ? "Artifact unavailable — original remains on this device" : "")}</p>
          </section>
        )}
        <BurstLibrary
          open={burstLibraryOpen}
          sessionId={sessionId}
          ownerParticipantId={participantId}
          participantCapability={participantCapability}
          bursts={burstHistory}
          localBurstSource={localBurstAsset}
          localPreviewStream={cameraStream}
          onClose={() => setBurstLibraryOpen(false)}
        />
      </main>
    );
  }

  return (
    <main className="program-shell">
      <section className={`program-stage ${mobileWallOpen ? "mobile-wall-open" : ""} ${programComposition === "sweep" ? "layout-sweep" : `layout-grid-${programComposition}`}`}>
        {activeFeeds.length ? activeFeeds.map((feed, index) => (
          <article
            className={`program-feed feed-${index + 1} ${index === activeFeeds.length - 1 ? "feed-last" : ""}`}
            key={`${scene.revision}-${feed.id}`}
            style={programComposition === "sweep" ? {
              animationDelay: `${index * PRODUCTION_SWEEP_STAGGER_MS}ms`,
            } : undefined}
          >
            <FeedVideo feed={feed} />
            <span className={`feed-label angle-${feed.angle.toLowerCase()}`}>
              <i />
              <b>{feed.angle} ANGLE</b>
              <span>{feed.label}</span>
            </span>
          </article>
        )) : (
          <div className="program-empty">
            <div className="empty-beam" aria-hidden="true" />
            <p className="eyebrow">MANYVUE · PROGRAM VIEW</p>
            <h1>DIRECT THE<br /><em>LIVE FILM.</em></h1>
            <p>Start the film, scan in real phones, then click any live angle to show it instantly.</p>
            <button
              className="program-empty-start"
              onClick={sessionStatus === "ended" ? createFreshRoom : startProgram}
              disabled={!programRoomReady || showLive || programStarting || programStopping}
            >
              {!programRoomReady ? "PREPARING LIVE ROOM…" : programStopping ? "STOPPING FILM…" : programStarting ? "OPENING LIVE ROOM…" : showLive ? "FILM IS LIVE · WAITING FOR CAMERAS" : sessionStatus === "ended" ? "START NEW FILM" : "START FILM"}
            </button>
          </div>
        )}

        <BurstExperience
          phase={burstPhase}
          count={Math.max(lastBurstCount, programBurstHistory?.readyCount ?? 0, burst?.count ?? 0)}
          total={programBurstHistory?.expectedCount ?? Math.max(feeds.length, 1)}
        />

        {burstPhase === "preserved" && (
          <aside className="burst-pipeline-status" role="status">
            <i aria-hidden="true" />
            <span><b>BURST PRESERVED · {Math.max(lastBurstCount, 1)} ANGLES</b> Phones upload synchronized microclips now while the live film keeps running.</span>
            <button onClick={() => setBurstPhase("idle")}>DISMISS</button>
          </aside>
        )}

        <header className="program-topbar">
          <BrandMark />
          <div className="program-status">
            <span className={`director-mode-badge ${directorAuto ? "auto" : "manual"}`}>{directorAuto ? "AUTO DIRECTOR" : "MANUAL CONTROL"}</span>
            <StatusPill tone={showLive ? "live" : sessionStatus === "ended" ? "warn" : "ready"}>{showLive ? "PROGRAM LIVE" : sessionStatus === "ended" ? "FILM ENDED" : "READY"}</StatusPill>
            <span>{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</span>
          </div>
        </header>

        <button
          type="button"
          className={`mobile-wall-toggle ${mobileWallOpen ? "is-open" : ""}`}
          onClick={() => setMobileWallOpen((current) => !current)}
          aria-expanded={mobileWallOpen}
          aria-controls="manyvue-camera-wall"
        >
          <span>{mobileWallOpen ? "BACK TO FILM" : "CAMERAS"}</span>
          <b>{feeds.length}</b>
        </button>

        <aside className={`persistent-join ${joinExpanded ? "expanded" : "compact"}`} aria-label="Join ManyVue camera room">
          {joinExpanded && (
            <button
              type="button"
              className="join-collapse"
              onClick={() => setJoinExpanded(false)}
              aria-label="Hide the join QR code and return to the live cameras"
            >
              <span aria-hidden="true">↓</span>
              HIDE QR · VIEW CAMERAS
            </button>
          )}
          <button className="join-qr" onClick={() => setJoinExpanded(true)} aria-label={joinExpanded ? "Camera join QR code" : "Enlarge camera join QR code"}>
            {qr
              ? <Image src={qr} alt="Scan to join ManyVue as a camera" width={960} height={960} unoptimized priority />
              : <span className="qr-loading">CREATING<br />LIVE ROOM…</span>}
          </button>
          <div className="join-details">
            <p className="eyebrow">PHONE CAMERA JOIN</p>
            <b>SCAN TO BECOME AN ANGLE</b>
            <span>Opens the camera directly. No account or app download.</span>
            {joinUrl && <code>{joinUrl.replace(/^https?:\/\//, "")}</code>}
            <div className="join-actions">
              <button onClick={() => void copyJoinLink()}>{joinCopied ? "LINK COPIED" : "COPY JOIN LINK"}</button>
              <a href={joinUrl || undefined} target="_blank" rel="noreferrer" aria-disabled={!joinUrl}>TEST JOIN PAGE</a>
              <button onClick={createFreshRoom}>NEW ROOM</button>
              <button onClick={() => setJoinExpanded(false)}>VIEW CAMERAS</button>
            </div>
          </div>
          {!joinExpanded && <button className="join-expand" onClick={() => setJoinExpanded(true)}>SCAN TO JOIN · ENLARGE</button>}
        </aside>

        <aside
          id="manyvue-camera-wall"
          className={`multiview-rail ${mobileWallOpen ? "mobile-open" : "mobile-closed"}`}
          aria-label="Live camera multiview"
        >
          <header>
            <div><span className={showLive ? "live-dot" : "ready-dot"} /> LIVE CAMERA WALL</div>
            <span className="rail-header-actions">
              <button className={`rail-mode ${directorAuto ? "auto" : "manual"}`} onClick={toggleDirectorAuto}>
                {directorAuto ? "AUTO ON" : "MANUAL"}
              </button>
              <button className="mobile-wall-close" type="button" onClick={() => setMobileWallOpen(false)}>DONE</button>
            </span>
          </header>
          <div className="angle-distribution">{STAGE_ANGLES.map((angle) => `${angle[0]}:${feeds.filter((feed) => feed.angle === angle).length}`).join("  ·  ")}</div>
          <div className="selection-summary">
            <span><b>{selectedFeeds.length}</b>/5 SELECTED · TAP + TO BUILD A MULTIVIEW</span>
            <button disabled={selectedFeeds.length === 0} onClick={() => setSelectedCameraIds([])}>CLEAR</button>
          </div>
          <div className="multiview-grid">
            {orderedFeeds.length ? orderedFeeds.slice(0, 8).map((feed, index) => {
              const onAir = showLive && (scene.activeIds.includes(feed.id) || (!scene.activeIds.length && index === 0));
              const selectedIndex = selectedCameraIds.indexOf(feed.id);
              return (
                <article
                  className={`multiview-card angle-${feed.angle.toLowerCase()} ${onAir ? "on-air" : ""} ${selectedIndex >= 0 ? "selected" : ""}`}
                  key={feed.id}
                >
                  <button
                    className="multiview-select"
                    onClick={() => takeFeed(feed)}
                    aria-label={`View ${feed.angle.toLowerCase()} angle ${feed.label} live`}
                  >
                    <span className="multiview-video"><FeedVideo feed={feed} /></span>
                    <span className="multiview-meta">
                      <b><span>{feed.angle}</span>{feed.label}</b>
                      <em>{onAir ? "ON PROGRAM" : "SHOW FULL SCREEN →"}</em>
                    </span>
                  </button>
                  <button
                    className="multiview-add"
                    onClick={() => toggleCameraSelection(feed)}
                    aria-pressed={selectedIndex >= 0}
                    aria-label={`${selectedIndex >= 0 ? "Remove" : "Add"} ${feed.label} ${selectedIndex >= 0 ? "from" : "to"} the multiview`}
                  >
                    {selectedIndex >= 0 ? `${selectedIndex + 1} · SELECTED` : "+ SELECT"}
                  </button>
                </article>
              );
            }) : (
              <div className="multiview-empty">
                <span>01</span>
                <b>NO CAMERAS YET</b>
                <p>Keep the QR visible. Every phone appears here as a live angle you can click immediately.</p>
              </div>
            )}
          </div>
          <div className={`multiview-launch ${multiviewActive ? "is-live" : ""}`}>
            <span>{multiviewActive ? `${activeFeeds.length} ANGLES ARE LIVE TOGETHER` : "SELECT 2–5 CAMERAS, THEN LAUNCH"}</span>
            <button
              type="button"
              onClick={multiviewActive ? exitMultiview : launchSelectedMultiview}
              disabled={!multiviewActive && selectedFeeds.length < 2}
            >
              {multiviewActive ? "EXIT MULTIVIEW · RETURN TO ONE ANGLE" : `LAUNCH ${selectedFeeds.length || ""} MULTIVIEW`}
            </button>
          </div>
          <div className="layout-controls" aria-label="Program layouts">
            {([1, 2, 3, 4, 5] as const).map((count) => (
              <button
                className={programComposition === count ? "active" : ""}
                key={count}
                disabled={selectedFeeds.length < count}
                onClick={() => takeSelectedLayout(count)}
              >
                <b>{count}</b><span>{count === 1 ? "FULL" : "VIEW"}</span>
              </button>
            ))}
            <button className={programComposition === "sweep" ? "active sweep-layout-control" : "sweep-layout-control"} disabled={selectedFeeds.length < 2} onClick={takeSweep}>SLOW SWEEP → HERO</button>
          </div>
        </aside>

        <footer className="program-footer">
          <div className="angle-count"><b>{feeds.length}</b><span>CONNECTED CAMERAS</span></div>
          <div className="director-label">
            <span>AI DIRECTOR</span>
            <b>{directorAuto ? "AUTO" : "MANUAL"}</b>
            <em>{directorDecision}</em>
            <em>VIDEO SYNC · NO LIVE MIC MIX</em>
          </div>
        </footer>
      </section>

      <section className="director-dock" aria-label="ManyVue production controls">
        <div className="dock-copy">
          <p className="eyebrow">LIVE PRODUCTION</p>
          <h2>{showLive ? directorDecision : "Start the film. Phones join as real cameras."}</h2>
          <p>{transportMessage || "Manual is the safe default. Turn AUTO on only when you want the director to cut for you."}</p>
        </div>
        <div className="dock-controls">
          <button
            className={`dock-button primary start-film-control ${showLive ? "stop-film-control" : ""}`}
            onClick={showLive ? stopProgram : sessionStatus === "ended" ? createFreshRoom : startProgram}
            disabled={programStarting || programStopping || (!showLive && sessionStatus !== "ended" && !programRoomReady)}
          >
            <b>{!programRoomReady ? "PREPARING ROOM…" : programStopping ? "STOPPING…" : programStarting ? "STARTING…" : showLive ? "STOP FILM" : sessionStatus === "ended" ? "START NEW FILM" : "START FILM"}</b>
            <small>{showLive ? `${feeds.length} cameras live · tap to end` : sessionStatus === "ended" ? "Open a fresh camera room" : programRoomReady ? "Open the Program View" : "Realtime handshake"}</small>
          </button>
          <button className="dock-button secondary host-angle-control" onClick={publishHostAngle} disabled={!programRoomReady || hostAnglePublished || hostPublishing}>
            {hostPublishing ? "OPENING CAMERA…" : hostAnglePublished ? "HOST ANGLE LIVE" : "ADD HOST CAMERA"}
          </button>
          <button className={`dock-button mode-control ${directorAuto ? "auto" : "manual"}`} onClick={toggleDirectorAuto}>
            <b>{directorAuto ? "AUTO DIRECTOR ON" : "MANUAL CONTROL"}</b>
            <small>{directorAuto ? "Tap to hold" : "Tap to automate"}</small>
          </button>
          <button className="dock-button burst-library-control" onClick={() => setBurstLibraryOpen(true)}>
            <b>VIEW BURSTS</b>
            <small>{burstHistory.length ? `${burstHistory.length} saved moments` : "Saved angle gallery"}</small>
          </button>
          <button
            className="dock-button burst-control"
            onClick={() => void triggerBurst()}
            disabled={crowdCameraCount === 0 || burstPending || !showLive || hostPublishing || hostBurstWarming}
            title={hostBurstWarming
              ? "Wait for the published host angle to retain its complete T−3 buffer."
              : crowdCameraCount === 0
                ? "At least one recording crowd camera is required."
                : "Cue the same Burst instant on every recording phone and the host angle."}
          >
            {hostBurstWarming ? "PRIMING HOST T−3…" : burstPending ? "SAVING BURST…" : "BURST ALL ANGLES"}
          </button>
        </div>
      </section>
      <BurstLibrary
        open={burstLibraryOpen}
        sessionId={sessionId}
        ownerParticipantId={participantId}
        participantCapability={participantCapability}
        convexSessionId={convexSessionId}
        hostCapability={hostCapability}
        bursts={burstHistory}
        programView
        onClose={() => setBurstLibraryOpen(false)}
      />
    </main>
  );
}
