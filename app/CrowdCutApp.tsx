"use client";

import QRCode from "qrcode";
import { ConvexClient } from "convex/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Room as LiveRoom } from "livekit-client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { burstEditCandidates, listBurstAssets, uploadBurstCaptureAssets } from "@/lib/artifacts/burst-upload";
import { DurableMediaRecorder } from "@/lib/media";
import { probeVideoDurationMs, tryCreateContactSheet } from "@/lib/media/video-artifact";

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
type BurstPhase = "idle" | "countdown" | "capturing" | "preview" | "preserved";
type ArtifactPhase = "idle" | "saved" | "uploading" | "waiting" | "editing" | "rendering" | "ready" | "failed";
type HostSession = { sessionId: string; slug: string; hostCapability: string };
type SharedBurstState = {
  _id: Id<"bursts">;
  anchorServerMs: number;
  windowStartServerMs: number;
  windowEndServerMs: number;
  expectedParticipantIds: Id<"participants">[];
  readyContributionCount: number;
};
type PrimedBurstCapture = {
  cueAt: number;
  result: Promise<{ blob: Blob; startedAtMs: number; endedAtMs: number }>;
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
  | { type: "burst_countdown"; by: string; at: number }
  | { type: "burst_request"; by: string; at: number; id: string }
  | { type: "burst_caught"; id: string; count: number }
  | { type: "session_state"; state: "live" | "ended" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STAGE_ANGLES: StageAngle[] = ["LEFT", "CENTER", "RIGHT"];
const ANGLE_RANK: Record<StageAngle, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };
const SWEEP_STAGGER_MS = 420;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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
      const sweep = distinctFeeds([left, center, right], ordered).slice(0, 6);
      return {
        layout: sweep.length > 1 ? "sweep" : "hero",
        feeds: sweep,
        decision: `SWEEP · ${sweep.map((feed) => feed.angle).join(" → ")}`,
      };
    }
  }
}

function FeedVideo({ feed, muted = true }: { feed: Feed; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = feed.stream;
    void ref.current.play().catch(() => undefined);
  }, [feed.stream]);

  return <video ref={ref} data-feed-id={feed.id} autoPlay playsInline muted={muted} aria-label={`${feed.label} live camera`} />;
}

function captureLiveFrame(feed: Feed): string | null {
  const video = [...document.querySelectorAll<HTMLVideoElement>("video[data-feed-id]")]
    .find((candidate) => candidate.dataset.feedId === feed.id && candidate.videoWidth > 0 && candidate.videoHeight > 0);
  if (!video) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 270;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#050509";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return canvas.toDataURL("image/jpeg", .62);
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="CrowdCut Live">
      <span className="brand-orbit" aria-hidden="true"><i /><i /><i /></span>
      <span>CROWD<span>CUT</span></span>
      <b>LIVE</b>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: "live" | "ready" | "warn"; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}><i aria-hidden="true" />{children}</span>;
}

function BurstExperience({
  phase,
  countdown,
  count,
  total,
  feeds = [],
}: {
  phase: BurstPhase;
  countdown: number;
  count: number;
  total: number;
  feeds?: Feed[];
}) {
  if (!(["countdown", "capturing", "preview"] as BurstPhase[]).includes(phase)) return null;
  const locked = Math.max(count, phase === "preview" ? Math.min(total, feeds.length) : 0);
  const progress = total ? Math.max(12, Math.min(100, (locked / total) * 100)) : phase === "capturing" ? 42 : 12;

  return (
    <div className={`burst-experience phase-${phase}`} role="status" aria-live="assertive">
      <div className="burst-experience-copy">
        <p className="eyebrow">SYNCHRONIZED CROWD CAPTURE</p>
        {phase === "countdown" && <strong className="burst-countdown" key={countdown}>{Math.max(1, countdown)}</strong>}
        {phase === "capturing" && <strong>LOCKING THE MOMENT</strong>}
        {phase === "preview" && <strong>MULTI-ANGLE PREVIEW</strong>}
        <span>
          {phase === "countdown"
            ? "Keep every camera rolling"
            : phase === "capturing"
              ? "Preserving the same instant across every live phone"
              : `${Math.max(locked, 1)} real ${Math.max(locked, 1) === 1 ? "angle" : "angles"} locked to one moment`}
        </span>
        {phase !== "countdown" && (
          <div className="burst-capture-progress" aria-label={`${locked} of ${Math.max(total, 1)} active angles locked`}>
            <i style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      {phase === "preview" && feeds.length > 0 && (
        <div className="burst-angle-preview" aria-label="Synchronized angle preview">
          {feeds.slice(0, 6).map((feed) => (
            <div className={`burst-angle-tile angle-${feed.angle.toLowerCase()}`} key={feed.id}>
              <FeedVideo feed={feed} />
              <b>{feed.angle}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CrowdCutApp() {
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
  const [joinExpanded, setJoinExpanded] = useState(false);
  const [joinCopied, setJoinCopied] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [scene, setScene] = useState<Scene>({ layout: "hero", activeIds: [], cutAt: 0, revision: 0 });
  const [, setTransport] = useState<"idle" | "connecting" | "live" | "rehearsal" | "error">("idle");
  const [transportMessage, setTransportMessage] = useState("");
  const [showLive, setShowLive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraViewMode, setCameraViewMode] = useState<"mine" | "live">("mine");
  const [cameraStartedAt, setCameraStartedAt] = useState(0);
  const [recording, setRecording] = useState(false);
  const [selectedLive, setSelectedLive] = useState(false);
  const [burst, setBurst] = useState<{ id: string; at: number; count: number } | null>(null);
  const [ownedBurst, setOwnedBurst] = useState<{ id: string; at: number; count: number } | null>(null);
  const [burstPending, setBurstPending] = useState(false);
  const [burstPhase, setBurstPhase] = useState<BurstPhase>("idle");
  const [burstCountdown, setBurstCountdown] = useState(0);
  const [burstCueAt, setBurstCueAt] = useState(0);
  const [lastBurstCount, setLastBurstCount] = useState(0);
  const [clipUrl, setClipUrl] = useState("");
  const [uploadState, setUploadState] = useState<"idle" | "queued" | "uploading" | "uploaded" | "failed">("idle");
  const [artifactPhase, setArtifactPhase] = useState<ArtifactPhase>("idle");
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactMessage, setArtifactMessage] = useState("");
  const [directorAuto, setDirectorAuto] = useState(false);
  const [directorDecision, setDirectorDecision] = useState("MANUAL HOLD · START THE FILM, THEN TAKE A CAMERA");
  const [visionBusy, setVisionBusy] = useState(false);
  const [programStarting, setProgramStarting] = useState(false);
  const [hostPublishing, setHostPublishing] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const roomRef = useRef<LiveRoom | null>(null);
  const participantIdRef = useRef("");
  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<DurableMediaRecorder | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const primedBurstRef = useRef<PrimedBurstCapture | null>(null);
  const burstPrimerHandlerRef = useRef<(cueAt: number) => void>(() => undefined);
  const burstCaptureIdsRef = useRef(new Set<string>());
  const burstCaptureHandlerRef = useRef<(sharedBurst: SharedBurstState) => void>(() => undefined);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const recordingStartedRef = useRef(0);
  const convexRef = useRef<ConvexClient | null>(null);
  const sequenceRef = useRef(0);
  const convexInitRef = useRef(false);
  const lastConvexBurstRef = useRef("");
  const renderIdRef = useRef("");
  const convexParticipantUnsubscribeRef = useRef<(() => void) | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const directorStepRef = useRef(0);
  const feedsRef = useRef<Feed[]>([]);
  const sweepTokenRef = useRef(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextView = params.get("view") === "camera" ? "camera" : "program";
    const nextSession = params.get("session") || "outside-live";
    const stored = window.localStorage.getItem("crowdcut-participant") || crypto.randomUUID();
    const savedAngle = window.localStorage.getItem(`crowdcut-angle-${nextSession}`);
    const initialAngle = STAGE_ANGLES.includes(savedAngle as StageAngle)
      ? (savedAngle as StageAngle)
      : angleFromIdentity(stored);
    window.localStorage.setItem("crowdcut-participant", stored);
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
    setCameraAngle(angle);
    setParticipantName(`${angle} · ${suffix}`);
    window.localStorage.setItem(`crowdcut-angle-${sessionId}`, angle);
  }, [participantId, participantName, sessionId]);

  useEffect(() => {
    feedsRef.current = feeds;
  }, [feeds]);

  useEffect(() => {
    if (!burstCueAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((burstCueAt - Date.now()) / 1000));
      setBurstCountdown(remaining);
      if (remaining <= 0) setBurstPhase((current) => current === "countdown" ? "capturing" : current);
    };
    tick();
    const timer = window.setInterval(tick, 120);
    return () => window.clearInterval(timer);
  }, [burstCueAt]);

  useEffect(() => {
    if (burstPhase !== "preview") return;
    const timer = window.setTimeout(() => setBurstPhase("preserved"), 3800);
    return () => window.clearTimeout(timer);
  }, [burstPhase]);

  useEffect(() => {
    if (!sessionId || view !== "program" || !convexSessionId) return;
    const nextJoinUrl = `${window.location.origin}/?view=camera&session=${encodeURIComponent(sessionId)}`;
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
        const mine = message.scene.activeIds.includes(participantIdRef.current);
        setSelectedLive(mine);
        if (mine && navigator.vibrate) navigator.vibrate(36);
      }, delay);
    }
    if (message.type === "burst_countdown") {
      setBurstCueAt(message.at);
      setBurstCountdown(Math.max(1, Math.ceil((message.at - Date.now()) / 1000)));
      setBurstPhase("countdown");
      setLastBurstCount(0);
      burstPrimerHandlerRef.current(message.at);
    }
    if (message.type === "burst_request" && view === "program") {
      setBurst({ id: message.id, at: message.at, count: 0 });
      setBurstPhase("preview");
    }
    if (message.type === "burst_caught") {
      setBurst((current) => current?.id === message.id ? { ...current, count: message.count } : current);
      setOwnedBurst((current) => current?.id === message.id ? { ...current, count: message.count } : current);
      setLastBurstCount(message.count);
      setBurstPhase("preview");
    }
    if (message.type === "session_state") setShowLive(message.state === "live");
  }, [view]);

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

    const subscribe = (slug: string, mine?: string) => {
      unsubscribe?.();
      unsubscribe = client.onUpdate(api.director.programState, { sessionSlug: slug }, (state) => {
        if (cancelled) return;
        setShowLive(state.session.status === "live");
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
            const mode = state.scene.source === "ai" ? "OPENAI VISION" : state.scene.source === "manual" ? "MANUAL" : "AI AUTO";
            setDirectorDecision(`${mode} · ${state.scene.reason.toUpperCase()}`);
          }
        }
        const sharedBurst = state.latestBurst;
        if (sharedBurst) {
          const sharedId = String(sharedBurst._id);
          setBurst((current) => current?.id === sharedId
            ? { ...current, count: Math.max(current.count, sharedBurst.readyContributionCount) }
            : current);
          setLastBurstCount((current) => Math.max(current, sharedBurst.readyContributionCount));
        }
        if (
          sharedBurst &&
          String(sharedBurst._id) !== lastConvexBurstRef.current &&
          (!mine || sharedBurst.expectedParticipantIds.map(String).includes(mine))
        ) {
          lastConvexBurstRef.current = String(sharedBurst._id);
          setBurst({
            id: String(sharedBurst._id),
            at: sharedBurst.anchorServerMs,
            count: sharedBurst.readyContributionCount,
          });
          setBurstPhase("preview");
        }
      }, (error) => setTransportMessage(`Convex realtime error: ${error.message}`));
    };

    void (async () => {
      if (view !== "program") return;
      const stored = window.localStorage.getItem("crowdcut-host-session");
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
        window.localStorage.removeItem("crowdcut-host-session");
        host = await client.action(api.sessions.create, {
          title: "Outside Lands CrowdCut Live",
          festivalName: "Outside Lands",
          stageName: "Hackathon Live",
        }) as HostSession;
        window.localStorage.setItem("crowdcut-host-session", JSON.stringify(host));
      }
      if (!host || cancelled) return;
      setSessionId(host.slug);
      setConvexSessionId(host.sessionId);
      setHostCapability(host.hostCapability);
      const joined = await client.action(api.participants.join, {
        sessionSlug: host.slug,
        displayName: "Host angle",
        role: "presenter",
        deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
        shotMetadata: { stageZone: "center", framing: "medium", confidence: 1, source: "self_reported" },
      });
      if (cancelled) return;
      setParticipantId(String(joined.participantId));
      participantIdRef.current = String(joined.participantId);
      setParticipantCapability(joined.participantCapability);
      window.localStorage.setItem("crowdcut-program-participant", JSON.stringify(joined));
      subscribe(host.slug);
      setTransportMessage("Convex production room ready");
    })().catch((error) => {
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
    if (!sessionId) return;
    const channel = new BroadcastChannel(`crowdcut-${sessionId}`);
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
        topic: "crowdcut-control",
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
      const joined = await client.action(api.participants.join, {
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
      });
      id = String(joined.participantId);
      capability = joined.participantCapability;
      livekitIdentity = joined.livekitIdentity;
      setParticipantId(id);
      participantIdRef.current = id;
      setParticipantCapability(capability);
      setConvexSessionId(String(joined.sessionId));
      window.localStorage.setItem(`crowdcut-camera-${sessionId}`, JSON.stringify(joined));
    }
    const convexParticipantId = id as Id<"participants">;

    // A stopped camera can record again without creating a duplicate person.
    // Reattach realtime state and explicitly re-enter backend recording every
    // time START MY ANGLE is pressed.
    convexParticipantUnsubscribeRef.current?.();
    convexParticipantUnsubscribeRef.current = client.onUpdate(api.director.programState, { sessionSlug: sessionId }, (state) => {
      setShowLive(state.session.status === "live");
      if (state.scene) {
        applyMessage({
          type: "scene",
          scene: {
            layout: state.scene.layout,
            activeIds: state.scene.activeParticipantIds.map(String),
            cutAt: state.scene.cutAtServerMs,
            revision: state.scene.revision,
          },
        });
      }
      const sharedBurst = state.latestBurst;
      if (sharedBurst) {
        const sharedId = String(sharedBurst._id);
        setBurst((current) => current?.id === sharedId
          ? { ...current, count: Math.max(current.count, sharedBurst.readyContributionCount) }
          : current);
        setOwnedBurst((current) => current?.id === sharedId
          ? { ...current, count: Math.max(current.count, sharedBurst.readyContributionCount) }
          : current);
        setLastBurstCount((current) => Math.max(current, sharedBurst.readyContributionCount));
      }
      if (
        sharedBurst &&
        String(sharedBurst._id) !== lastConvexBurstRef.current &&
        sharedBurst.expectedParticipantIds.map(String).includes(id)
      ) {
        lastConvexBurstRef.current = String(sharedBurst._id);
        burstCaptureHandlerRef.current(sharedBurst as SharedBurstState);
      }
    });
    sequenceRef.current += 1;
    await client.mutation(api.participants.beginRecording, {
      participantId: convexParticipantId,
      participantCapability: capability,
      clientSequence: sequenceRef.current,
      deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
    });
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    heartbeatRef.current = window.setInterval(() => {
      sequenceRef.current += 1;
      void client.mutation(api.participants.heartbeat, {
        participantId: convexParticipantId,
        participantCapability: capability,
        clientSequence: sequenceRef.current,
        connectionState: navigator.onLine ? "online" : "offline",
      });
    }, 5000);
    return { id, capability, livekitIdentity };
  }, [applyMessage, cameraAngle, participantCapability, participantId, participantName, sessionId]);

  const registerRoomListeners = useCallback(async (room: LiveRoom, role: "program" | "camera") => {
    const livekit = await import("livekit-client");
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
      // for a responsive in-hand LIVE CUT monitor.
      publication.setVideoQuality(role === "program" ? livekit.VideoQuality.HIGH : livekit.VideoQuality.MEDIUM);
      publication.setVideoFPS(role === "program" ? 30 : 24);
      addTrack(track, participant);
    });
    room.on(livekit.RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
      setFeeds((current) => current.filter((feed) => feed.id !== participant.identity));
    });
    room.on(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
      setFeeds((current) => current.filter((feed) => feed.id !== participant.identity));
    });
  }, [applyMessage]);

  const connectTransport = useCallback(async (role: "program" | "camera", stream?: MediaStream, identityOverride?: string) => {
    if (!participantId || roomRef.current?.state === "connected") return roomRef.current;
    setTransport("connecting");
    setTransportMessage("Connecting the crowd…");
    try {
      const response = await fetch(
        `/api/livekit-token?session=${encodeURIComponent(sessionId)}&participant=${encodeURIComponent(identityOverride || participantId)}&role=${role}&name=${encodeURIComponent(participantName)}`,
      );
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
  }, [participantId, participantName, registerRoomListeners, sessionId]);

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
          const assets = await listBurstAssets(sessionId, targetBurst.id);
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
      setArtifactMessage("Rendering your real multi-angle CrowdCut…");
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
          setArtifactMessage("Your shareable CrowdCut is ready — every angle is real.");
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
  }, [ownedBurst, participantId, sessionId]);

  const primeBurstCapture = useCallback((cueAt: number) => {
    const existing = primedBurstRef.current;
    if (existing && Math.abs(existing.cueAt - cueAt) < 4_000) return existing.result;
    const stream = cameraStreamRef.current;
    if (!stream?.getVideoTracks().some((track) => track.readyState === "live")) return null;
    const startedAtMs = Date.now();
    const recorder = new DurableMediaRecorder(stream, {
      recordingId: crypto.randomUUID(),
      participantId: participantIdRef.current,
      chunkDurationMs: 500,
      videoBitsPerSecond: 1_000_000,
      audioBitsPerSecond: 64_000,
    });
    const result = (async () => {
      await recorder.start();
      // Countdown messages prime one complete, independently playable file:
      // anticipation before the cue plus the reaction immediately after it.
      await wait(Math.max(4_000, cueAt + 2_500 - Date.now()));
      const stopped = await recorder.stop();
      return { blob: stopped.blob, startedAtMs, endedAtMs: Date.now() };
    })();
    primedBurstRef.current = { cueAt, result };
    return result;
  }, []);

  useEffect(() => {
    burstPrimerHandlerRef.current = (cueAt) => { void primeBurstCapture(cueAt); };
  }, [primeBurstCapture]);

  const captureBurstContribution = useCallback(async (sharedBurst: SharedBurstState) => {
    const sharedId = String(sharedBurst._id);
    const marker = { id: sharedId, at: sharedBurst.anchorServerMs, count: sharedBurst.readyContributionCount };
    setBurst(marker);
    setOwnedBurst(marker);
    if (burstCaptureIdsRef.current.has(sharedId)) return;
    burstCaptureIdsRef.current.add(sharedId);
    setBurstPhase("capturing");
    setUploadState("uploading");
    setArtifactPhase("uploading");
    setArtifactMessage("Capturing and uploading this shared moment while every camera keeps filming…");
    try {
      const client = convexRef.current;
      const primedCapture = primeBurstCapture(sharedBurst.anchorServerMs);
      if (!primedCapture || !client || !participantCapability || !participantId) {
        throw new Error("This camera is not ready to preserve the Burst yet.");
      }
      const capture = await primedCapture;
      const elapsedMs = Math.max(1, capture.endedAtMs - capture.startedAtMs);
      const probe = await probeVideoDurationMs(capture.blob, elapsedMs);
      const burstOffsetMs = Math.min(
        probe.durationMs,
        Math.max(0, sharedBurst.anchorServerMs - capture.startedAtMs),
      );

      await client.mutation(api.bursts.acknowledgePreserved, {
        participantId: participantId as Id<"participants">,
        participantCapability,
        burstId: sharedBurst._id,
        preservedStartMs: Math.max(0, capture.startedAtMs - recordingStartedRef.current),
        preservedEndMs: Math.max(1, capture.endedAtMs - recordingStartedRef.current),
      });

      const sheet = await tryCreateContactSheet(capture.blob, burstOffsetMs);
      const uploaded = await uploadBurstCaptureAssets({
        session: sessionId,
        participant: participantId,
        burstId: sharedId,
        clip: capture.blob,
        thumbnail: sheet.ok ? sheet.blob : null,
        durationMs: probe.durationMs,
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
        durationMs: probe.durationMs,
        startsAtServerMs: Math.round(capture.startedAtMs),
        endsAtServerMs: Math.round(capture.endedAtMs),
      });
      if (primedBurstRef.current?.cueAt === sharedBurst.anchorServerMs) primedBurstRef.current = null;
      setUploadState("uploaded");
      setBurstPhase("preview");
      setArtifactPhase("waiting");
      setArtifactMessage(uploaded.thumbnailWarning
        ? "Your real Burst clip is uploaded. Waiting for the other synchronized angles…"
        : "Your angle is uploaded. Building your personal multi-angle CrowdCut…");
      await buildArtifact(marker);
    } catch (error) {
      setUploadState("failed");
      setArtifactPhase("failed");
      setArtifactMessage(error instanceof Error ? error.message : "Burst upload failed; your full original remains safe on this device.");
      burstCaptureIdsRef.current.delete(sharedId);
    }
  }, [buildArtifact, participantCapability, participantId, primeBurstCapture, sessionId]);

  useEffect(() => {
    burstCaptureHandlerRef.current = (sharedBurst) => { void captureBurstContribution(sharedBurst); };
  }, [captureBurstContribution]);

  const startCamera = useCallback(async () => {
    setTransportMessage("Opening your angle…");
    try {
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
      setCameraStream(stream);
      cameraStreamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play();
      }

      const convexCamera = await ensureConvexCamera();

      const recorder = new DurableMediaRecorder(stream, {
        recordingId: crypto.randomUUID(),
        participantId: convexCamera.id,
        chunkDurationMs: 1000,
        videoBitsPerSecond: 4_000_000,
      });
      await recorder.start();
      const startedAt = Date.now();
      recordingStartedRef.current = startedAt;
      setCameraStartedAt(startedAt);
      recorderRef.current = recorder;
      setRecording(true);
      await connectTransport("camera", stream, convexCamera.livekitIdentity);
    } catch (error) {
      setTransport("error");
      setTransportMessage(error instanceof Error ? error.message : "Camera permission was not granted.");
    }
  }, [connectTransport, ensureConvexCamera]);

  const stopCamera = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      const result = await recorder.stop();
      const localUrl = URL.createObjectURL(result.blob);
      setClipUrl((current) => { if (current) URL.revokeObjectURL(current); return localUrl; });
      setUploadState((current) => current === "idle" ? "queued" : current);
      setArtifactPhase((current) => current === "idle" ? "saved" : current);
      setArtifactMessage((current) => current || "Your complete original is saved on this device and ready to download.");
    }
    primedBurstRef.current = null;
    setRecording(false);
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
  }, [cameraStream, participantCapability, participantId]);

  const triggerBurst = useCallback(async () => {
    const hostCanCue = view === "program" && showLive && feedsRef.current.some((feed) => !feed.local);
    if (burstPending || (view === "camera" && !recording) || (view === "program" && !hostCanCue)) return;
    setBurstPending(true);
    const markerId = crypto.randomUUID();
    const cueAt = Date.now() + 2_700;
    setBurstCueAt(cueAt);
    setBurstCountdown(3);
    setBurstPhase("countdown");
    setLastBurstCount(0);
    try {
      if (view === "camera") void primeBurstCapture(cueAt);
      await send({ type: "burst_countdown", by: participantId, at: cueAt });
      await wait(Math.max(0, cueAt - Date.now()));
      setBurstPhase("capturing");
      if (navigator.vibrate) navigator.vibrate([32, 24, 64]);
      if (convexRef.current && participantCapability) {
        const result = view === "program" && convexSessionId && hostCapability
          ? await convexRef.current.mutation(api.bursts.triggerByHost, {
              sessionId: convexSessionId as Id<"sessions">,
              hostCapability,
              actorParticipantId: participantId as Id<"participants">,
              clientMarkerId: markerId,
              clientObservedAtMs: Date.now(),
            })
          : await convexRef.current.mutation(api.bursts.trigger, {
              participantId: participantId as Id<"participants">,
              participantCapability,
              clientMarkerId: markerId,
              clientObservedAtMs: Date.now(),
            });
        if (result.burst) {
          const marker = { id: String(result.burst._id), at: result.burst.anchorServerMs, count: result.burst.readyContributionCount };
          lastConvexBurstRef.current = marker.id;
          setBurst(marker);
          setLastBurstCount(marker.count);
          if (view === "camera") {
            setOwnedBurst(marker);
            burstCaptureHandlerRef.current(result.burst as SharedBurstState);
          } else setBurstPhase("preview");
        }
        return;
      }
      const marker = { id: markerId, at: Date.now(), count: 1 };
      setBurst(marker);
      setOwnedBurst(marker);
      setLastBurstCount(1);
      setBurstPhase("preview");
      await send({ type: "burst_request", by: participantId, at: marker.at, id: marker.id });
    } catch (error) {
      setBurstPhase("idle");
      setTransportMessage(error instanceof Error ? error.message : "Crowd Burst could not be captured.");
      if (navigator.vibrate) navigator.vibrate([90, 45, 90]);
    } finally {
      setBurstPending(false);
    }
  }, [burstPending, convexSessionId, hostCapability, participantCapability, participantId, primeBurstCapture, recording, send, showLive, view]);

  const commitScene = useCallback(async (
    activeIds: string[],
    layout: SceneLayout,
    reason?: string,
    sourceOverride?: "manual" | "deterministic" | "ai",
  ) => {
    const issuedAt = Date.now();
    const next: Scene = {
      layout,
      activeIds,
      cutAt: issuedAt + 600,
      revision: issuedAt,
    };
    if (convexRef.current && convexSessionId && hostCapability && activeIds.length) {
      await convexRef.current.mutation(api.director.scheduleScene, {
        sessionId: convexSessionId as Id<"sessions">,
        hostCapability,
        layout,
        activeParticipantIds: activeIds.map((id) => id as Id<"participants">),
        cutAtServerMs: next.cutAt,
        source: sourceOverride ?? (reason?.startsWith("Manual") ? "manual" : directorAuto ? "ai" : "manual"),
        reason: reason ?? (directorAuto ? "Stage-aware deterministic AI direction" : "Presenter TAKE"),
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
      setJoinExpanded(false);
      setElapsed(0);
      setDirectorDecision(feedsRef.current.length
        ? "MANUAL HOLD · CLICK A CAMERA TO TAKE IT LIVE"
        : "MANUAL HOLD · WAITING FOR FIRST CAMERA");
      await send({ type: "session_state", state: "live" });
    } catch (error) {
      setTransportMessage(error instanceof Error ? error.message : "The live film could not start.");
    } finally {
      setProgramStarting(false);
    }
  }, [connectTransport, convexSessionId, hostCapability, participantId, programStarting, send, showLive]);

  const publishHostAngle = useCallback(async () => {
    if (hostPublishing || feedsRef.current.some((feed) => feed.local)) return;
    setHostPublishing(true);
    try {
      if (!showLive) await startProgram();
      setTransportMessage("Opening this computer's optional host camera…");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: false,
      });
      if (convexRef.current && participantCapability) {
        sequenceRef.current += 1;
        await convexRef.current.mutation(api.participants.updateShotMetadata, {
          participantId: participantId as Id<"participants">,
          participantCapability,
          shotMetadata: { stageZone: "center", framing: "medium", confidence: 1, source: "self_reported" },
        });
        await convexRef.current.mutation(api.participants.beginRecording, {
          participantId: participantId as Id<"participants">,
          participantCapability,
          clientSequence: sequenceRef.current,
          deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
        });
      }
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
      const host: Feed = {
        id: participantId,
        angle: "CENTER",
        label: "HOST",
        stream,
        local: true,
        joinedAt: Date.now(),
      };
      setFeeds((current) => [...current.filter((feed) => feed.id !== host.id), host]);
      const startedAt = Date.now();
      recordingStartedRef.current = startedAt;
      setCameraStartedAt(startedAt);
      setRecording(true);
      setTransportMessage("Host angle is live. The host can now trigger a synchronized Burst.");
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = window.setInterval(() => {
        if (!convexRef.current || !participantCapability) return;
        sequenceRef.current += 1;
        void convexRef.current.mutation(api.participants.heartbeat, {
          participantId: participantId as Id<"participants">,
          participantCapability,
          clientSequence: sequenceRef.current,
          connectionState: navigator.onLine ? "online" : "offline",
        });
      }, 5000);
    } catch (error) {
      setTransportMessage(error instanceof Error ? error.message : "Host camera could not start.");
    } finally {
      setHostPublishing(false);
    }
  }, [connectTransport, hostPublishing, participantCapability, participantId, showLive, startProgram]);

  useEffect(() => {
    if (!showLive) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [showLive]);

  const orderedFeeds = useMemo(() => orderedByStage(feeds), [feeds]);

  const takeFeed = useCallback((feed: Feed) => {
    sweepTokenRef.current += 1;
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL TAKE · ${feed.angle} · ${feed.label}`);
    void (async () => {
      if (!showLive) await startProgram();
      await commitScene(
        [feed.id],
        "hero",
        `Manual full-screen TAKE from the ${feed.angle.toLowerCase()} stage angle`,
      );
    })().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The camera TAKE failed.");
    });
  }, [commitScene, showLive, startProgram]);

  const takeDuo = useCallback(() => {
    const directed = stageAwareDirectorScene(feeds, 2);
    const pair = directed.feeds.slice(0, 2);
    if (!pair.length) return;
    sweepTokenRef.current += 1;
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL DUO · ${pair.map((feed) => feed.angle).join(" + ")}`);
    void (async () => {
      if (!showLive) await startProgram();
      await commitScene(
        pair.map((feed) => feed.id),
        pair.length > 1 ? "duo" : "hero",
        `Manual complementary-angle DUO: ${pair.map((feed) => feed.angle).join(" + ")}`,
      );
    })().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The DUO TAKE failed.");
    });
  }, [commitScene, feeds, showLive, startProgram]);

  const takeSweep = useCallback(() => {
    const sweep = orderedByStage(feeds).slice(0, 6);
    if (!sweep.length) return;
    const sweepToken = ++sweepTokenRef.current;
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
      }, 1_600 + (sweep.length - 1) * SWEEP_STAGGER_MS);
    })().catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The SWEEP TAKE failed.");
    });
  }, [commitScene, feeds, showLive, startProgram]);

  const toggleDirectorAuto = useCallback(() => {
    sweepTokenRef.current += 1;
    const next = !directorAuto;
    setDirectorAuto(next);
    setDirectorDecision(
      next ? "AI AUTO · STAGE-AWARE ROTATION" : "MANUAL HOLD · CLICK ANY CAMERA TO TAKE",
    );
  }, [directorAuto]);

  const runVisionTake = useCallback(async () => {
    if (visionBusy || feeds.length === 0) return;
    setVisionBusy(true);
    setDirectorDecision("OPENAI VISION · READING LIVE CAMERA FRAMES…");
    try {
      const cameras = orderedByStage(feeds).slice(0, 4).flatMap((feed) => {
        const imageDataUrl = captureLiveFrame(feed);
        return imageDataUrl ? [{ id: feed.id, label: feed.label, zone: feed.angle, imageDataUrl }] : [];
      });
      if (!cameras.length) throw new Error("Live frames are still warming up. Try the Vision Take again.");
      const response = await fetch("/api/ai/live-director", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cameras }),
      });
      const result = await response.json() as {
        state?: "generated" | "deterministic";
        decision?: { layout: "hero" | "duo"; activeIds: string[]; headline: string; reason: string };
        error?: string;
      };
      if (!response.ok || !result.decision) throw new Error(result.error || "Vision director could not read the live angles.");
      setDirectorAuto(false);
      const mode = result.state === "generated" ? "OPENAI VISION" : "VISION FALLBACK";
      setDirectorDecision(`${mode} · ${result.decision.headline.toUpperCase()}`);
      setTransportMessage(`${mode}: ${result.decision.reason}`);
      await commitScene(
        result.decision.activeIds,
        result.decision.layout,
        `${mode}: ${result.decision.reason}`,
        result.state === "generated" ? "ai" : "deterministic",
      );
    } catch (error) {
      setTransportMessage(error instanceof Error ? error.message : "Vision director failed.");
      setDirectorDecision("AI AUTO · LIVE VISION UNAVAILABLE");
    } finally {
      setVisionBusy(false);
    }
  }, [commitScene, feeds, visionBusy]);

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
    // TAKE immediately when AUTO is enabled; subsequent cuts follow the
    // predictable production cadence. A presenter should never click AUTO
    // and wonder whether anything happened.
    directNow();
    const timer = window.setInterval(directNow, 3600);
    return () => window.clearInterval(timer);
  }, [burst, commitScene, convexSessionId, directorAuto, hostCapability, showLive, view]);

  useEffect(() => {
    if (view !== "program" || !burst || feeds.length === 0) return;
    const burstFeeds = orderedByStage(feeds).slice(0, 6);
    const ids = burstFeeds.map((feed) => feed.id);
    const landingHero = pickAngle(burstFeeds, "CENTER", 0) ?? burstFeeds[burstFeeds.length - 1];
    sweepTokenRef.current += 1;
    queueMicrotask(() => {
      setBurstPhase("preview");
      setLastBurstCount(ids.length);
      setBurst((current) => current ? { ...current, count: Math.max(current.count, ids.length) } : current);
      setDirectorDecision(
        `BURST PREVIEW · ${burstFeeds.map((feed) => feed.angle).join(" → ")}`,
      );
    });
    void commitScene(
      ids,
      ids.length > 1 ? "sweep" : "hero",
      "Crowd Burst stage-relative perspective sweep",
    );
    void send({ type: "burst_caught", id: burst.id, count: ids.length });
    const timer = window.setTimeout(() => {
      setBurst(null);
      setBurstPhase("preserved");
      setDirectorDecision(`BURST PRESERVED · LANDED ON ${landingHero.angle} HERO`);
      void commitScene(
        [landingHero.id],
        "hero",
        `Crowd Burst completed and landed on ${landingHero.angle.toLowerCase()} hero`,
      );
    }, 1_600 + (burstFeeds.length - 1) * SWEEP_STAGGER_MS);
    return () => window.clearTimeout(timer);
    // Burst is intentionally a single scheduled production moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burst?.id, feeds.length, view]);

  useEffect(() => () => {
    roomRef.current?.disconnect();
    cameraStream?.getTracks().forEach((track) => track.stop());
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  }, [cameraStream, clipUrl]);

  const activeFeeds = useMemo(() => {
    const selected = scene.activeIds.map((id) => feeds.find((feed) => feed.id === id)).filter(Boolean) as Feed[];
    const directedFallback = stageAwareDirectorScene(orderedFeeds, 0).feeds;
    return selected.length
      ? selected
      : directedFallback.slice(0, scene.layout === "duo" ? 2 : 1);
  }, [feeds, orderedFeeds, scene.activeIds, scene.layout]);

  const cameraLiveFeeds = useMemo(() => {
    const selected = scene.activeIds.flatMap((id) => {
      if (id === participantId && cameraStream) {
        return [{
          id,
          angle: cameraAngle,
          label: "MY ANGLE",
          stream: cameraStream,
          local: true,
          joinedAt: cameraStartedAt,
        } satisfies Feed];
      }
      const remote = feeds.find((feed) => feed.id === id);
      return remote ? [remote] : [];
    });
    if (selected.length) return selected;
    if (orderedFeeds.length) return orderedFeeds.slice(0, scene.layout === "duo" ? 2 : 1);
    if (cameraStream) return [{
      id: participantId,
      angle: cameraAngle,
      label: "MY ANGLE",
      stream: cameraStream,
      local: true,
      joinedAt: cameraStartedAt,
    } satisfies Feed];
    return [];
  }, [cameraAngle, cameraStartedAt, cameraStream, feeds, orderedFeeds, participantId, scene.activeIds, scene.layout]);

  const hostAnglePublished = feeds.some((feed) => feed.local);
  const crowdCameraCount = feeds.filter((feed) => !feed.local).length;
  const programRoomReady = booted && Boolean(participantId) && (
    !process.env.NEXT_PUBLIC_CONVEX_URL || Boolean(convexSessionId && hostCapability)
  );
  const artifactUploadDone = (["waiting", "editing", "rendering", "ready"] as ArtifactPhase[]).includes(artifactPhase);
  const artifactEditDone = (["rendering", "ready"] as ArtifactPhase[]).includes(artifactPhase);

  if (view === "camera") {
    return (
      <main className={`camera-shell ${selectedLive ? "is-live" : ""}`}>
        <video
          ref={previewRef}
          className={`camera-preview ${recording && cameraViewMode === "live" && cameraLiveFeeds.length ? "is-hidden" : ""}`}
          autoPlay
          muted
          playsInline
        />
        {recording && cameraViewMode === "live" && cameraLiveFeeds.length > 0 && (
          <div className={`camera-live-cut layout-${cameraLiveFeeds.length > 1 ? "duo" : "hero"}`}>
            {cameraLiveFeeds.slice(0, 2).map((feed) => (
              <div className="camera-live-feed" key={feed.id}>
                <FeedVideo feed={feed} />
                <span>{feed.id === participantId
                  ? selectedLive ? "YOUR ANGLE · ON AIR" : "MY ANGLE · PROGRAM WAITING"
                  : `${feed.angle} · ${feed.label}`}</span>
              </div>
            ))}
          </div>
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
            <button className={cameraViewMode === "mine" ? "selected" : ""} onClick={() => setCameraViewMode("mine")}>MY ANGLE</button>
            <button className={cameraViewMode === "live" ? "selected" : ""} onClick={() => setCameraViewMode("live")}>
              LIVE CUT <i aria-hidden="true" />
            </button>
          </div>
        )}

        <BurstExperience
          phase={burstPhase}
          countdown={burstCountdown}
          count={Math.max(lastBurstCount, ownedBurst?.count ?? burst?.count ?? 0)}
          total={Math.max(cameraLiveFeeds.length, 1)}
          feeds={cameraLiveFeeds}
        />

        {!recording && !clipUrl && (
          <section className="camera-intro">
            <p className="eyebrow">YOU ARE THE CAMERA</p>
            <h1>Record your angle.<br /><em>Take home the crowd.</em></h1>
            <p>Your mic is saved with your personal recording but is never broadcast into the room, so the live screen cannot create phone-speaker feedback.</p>
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
            <button className="record-trigger" onClick={startCamera}>
              <span aria-hidden="true" /> START MY {cameraAngle} ANGLE
            </button>
            {transportMessage && <p className="inline-message">{transportMessage}</p>}
          </section>
        )}

        {recording && (
          <section className="camera-controls">
            <div className="recording-readout"><i /> {cameraAngle} ANGLE · VIDEO LIVE · MIC LOCAL <b>{String(elapsed).padStart(2, "0")}s</b></div>
            <button className={`burst-trigger ${ownedBurst ? "caught" : ""}`} onClick={triggerBurst} disabled={burstPending}>
              <span className="burst-rings" aria-hidden="true"><i /><i /></span>
              <b>{burstPending ? "CATCHING EVERY ANGLE…" : ownedBurst ? "BURST CAUGHT · TAP FOR ANOTHER" : "BURST THIS MOMENT"}</b>
              <small>{ownedBurst ? `${Math.max(1, ownedBurst.count)} angles captured your moment` : "Keep filming — the crowd captures every angle"}</small>
            </button>
            {burstPhase === "preserved" && ownedBurst && (
              <p className="camera-burst-preserved"><b>BURST PRESERVED</b> Your synchronized angle uploads now while the full recording continues uninterrupted.</p>
            )}
            <button className="stop-trigger" onClick={stopCamera}>Stop & build my CrowdCut</button>
            {transportMessage && <p className="inline-message camera-inline-message">{transportMessage}</p>}
          </section>
        )}

        {clipUrl && !recording && (
          <section className="artifact-card">
            <p className="eyebrow">YOUR MOMENT IS REAL</p>
            <h2>{artifactUrl ? "Your CrowdCut is ready." : "Your angle is safe."}</h2>
            <div className={`artifact-pipeline phase-${artifactPhase}`} aria-label="CrowdCut artifact progress">
              <span className="complete"><i />SAVED</span>
              <span className={artifactUploadDone ? "complete" : artifactPhase === "uploading" ? "active" : ""}><i />UPLOAD</span>
              <span className={artifactEditDone ? "complete" : (["waiting", "editing"] as ArtifactPhase[]).includes(artifactPhase) ? "active" : ""}><i />AI CUT</span>
              <span className={artifactPhase === "ready" ? "complete" : artifactPhase === "rendering" ? "active" : ""}><i />RENDER</span>
              <span className={artifactPhase === "ready" ? "active" : ""}><i />DOWNLOAD</span>
            </div>
            <video src={artifactUrl || clipUrl} controls playsInline />
            <div className="artifact-actions">
              <a href={artifactUrl || clipUrl} download={artifactUrl ? "my-crowdcut.mp4" : "my-angle.webm"}>{artifactUrl ? "DOWNLOAD CROWD CUT" : "DOWNLOAD MY ANGLE"}</a>
              {ownedBurst && !artifactUrl && (["waiting", "failed", "rendering"] as ArtifactPhase[]).includes(artifactPhase) && (
                <button onClick={() => void buildArtifact()}>
                  {artifactPhase === "rendering" ? "CHECK RENDER" : artifactPhase === "waiting" ? "RETRY MULTI-ANGLE BUILD" : "BUILD FROM REAL ANGLES"}
                </button>
              )}
              <button onClick={() => {
                setClipUrl("");
                setArtifactUrl("");
                setArtifactMessage("");
                setBurst(null);
                setOwnedBurst(null);
                setUploadState("idle");
                setArtifactPhase("idle");
                setBurstPhase("idle");
                renderIdRef.current = "";
              }}>Record another</button>
            </div>
            <p className={`upload-state ${uploadState}`}>{artifactMessage || (uploadState === "uploading" ? "Uploading the real source…" : uploadState === "failed" ? "Artifact unavailable — original remains on this device" : "")}</p>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="program-shell">
      <section className={`program-stage layout-${scene.layout} ${burst ? "bursting" : ""}`}>
        {activeFeeds.length ? activeFeeds.map((feed, index) => (
          <article
            className={`program-feed feed-${index + 1} ${index === activeFeeds.length - 1 ? "feed-last" : ""}`}
            key={`${scene.revision}-${feed.id}`}
            style={scene.layout === "sweep" ? { animationDelay: `${index * SWEEP_STAGGER_MS}ms` } : undefined}
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
            <p className="eyebrow">CROWDCUT · PROGRAM VIEW</p>
            <h1>DIRECT THE<br /><em>LIVE FILM.</em></h1>
            <p>Start the film, scan in real phones, then click any angle to TAKE it live.</p>
            <button className="program-empty-start" onClick={startProgram} disabled={!programRoomReady || showLive || programStarting}>
              {!programRoomReady ? "PREPARING LIVE ROOM…" : programStarting ? "OPENING LIVE ROOM…" : showLive ? "FILM IS LIVE · WAITING FOR CAMERAS" : "START FILM"}
            </button>
          </div>
        )}

        <BurstExperience
          phase={burstPhase}
          countdown={burstCountdown}
          count={Math.max(lastBurstCount, burst?.count ?? 0)}
          total={Math.max(feeds.length, 1)}
          feeds={orderedFeeds}
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
            <StatusPill tone={showLive ? "live" : "ready"}>{showLive ? "PROGRAM LIVE" : "READY"}</StatusPill>
            <span>{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</span>
          </div>
        </header>

        <aside className={`persistent-join ${joinExpanded ? "expanded" : "compact"}`} aria-label="Join CrowdCut camera room">
          <button className="join-qr" onClick={() => setJoinExpanded(true)} aria-label={joinExpanded ? "Camera join QR code" : "Enlarge camera join QR code"}>
            {qr
              ? <img src={qr} alt="Scan to join CrowdCut as a camera" />
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
              <button onClick={() => setJoinExpanded(false)}>COLLAPSE</button>
            </div>
          </div>
          {!joinExpanded && <button className="join-expand" onClick={() => setJoinExpanded(true)}>SCAN TO JOIN · ENLARGE</button>}
        </aside>

        <aside className="multiview-rail" aria-label="Live camera multiview">
          <header>
            <div><span className={showLive ? "live-dot" : "ready-dot"} /> MULTIVIEW · CLICK TO TAKE</div>
            <button className={`rail-mode ${directorAuto ? "auto" : "manual"}`} onClick={toggleDirectorAuto}>
              {directorAuto ? "AUTO ON" : "MANUAL"}
            </button>
          </header>
          <div className="angle-distribution">{STAGE_ANGLES.map((angle) => `${angle[0]}:${feeds.filter((feed) => feed.angle === angle).length}`).join("  ·  ")}</div>
          <div className="multiview-grid">
            {orderedFeeds.length ? orderedFeeds.slice(0, 8).map((feed, index) => {
              const onAir = showLive && (scene.activeIds.includes(feed.id) || (!scene.activeIds.length && index === 0));
              return (
                <button
                  className={`multiview-card angle-${feed.angle.toLowerCase()} ${onAir ? "on-air" : ""}`}
                  key={feed.id}
                  onClick={() => takeFeed(feed)}
                  aria-label={`Take ${feed.angle.toLowerCase()} angle ${feed.label} full screen`}
                >
                  <span className="multiview-video"><FeedVideo feed={feed} /></span>
                  <span className="multiview-meta">
                    <b><span>{feed.angle}</span>{feed.label}</b>
                    <em>{onAir ? "ON AIR" : "TAKE →"}</em>
                  </span>
                </button>
              );
            }) : (
              <div className="multiview-empty">
                <span>01</span>
                <b>NO CAMERAS YET</b>
                <p>Keep the QR visible. Every phone appears here as a clickable TAKE.</p>
              </div>
            )}
          </div>
          <div className="layout-controls" aria-label="Program layouts">
            <button className={scene.layout === "hero" ? "active" : ""} disabled={feeds.length === 0} onClick={() => { const target = activeFeeds[0] ?? orderedFeeds[0]; if (target) takeFeed(target); }}>HERO TAKE</button>
            <button className={scene.layout === "duo" ? "active" : ""} disabled={feeds.length < 2} onClick={takeDuo}>DUO</button>
            <button className={scene.layout === "sweep" ? "active" : ""} disabled={feeds.length < 2} onClick={takeSweep}>SWEEP → HERO</button>
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

      <section className="director-dock" aria-label="CrowdCut production controls">
        <div className="dock-copy">
          <p className="eyebrow">LIVE PRODUCTION</p>
          <h2>{showLive ? directorDecision : "Start the film. Phones join as real cameras."}</h2>
          <p>{transportMessage || "Manual is the safe default. Turn AUTO on only when you want the director to cut for you."}</p>
        </div>
        <div className="dock-controls">
          <button className="dock-button primary start-film-control" onClick={startProgram} disabled={!programRoomReady || showLive || programStarting}>
            <b>{!programRoomReady ? "PREPARING ROOM…" : programStarting ? "STARTING…" : showLive ? "FILM LIVE" : "START FILM"}</b>
            <small>{showLive ? `${feeds.length} cameras ready` : programRoomReady ? "Open the Program View" : "Realtime handshake"}</small>
          </button>
          <button className="dock-button secondary host-angle-control" onClick={publishHostAngle} disabled={!programRoomReady || hostAnglePublished || hostPublishing}>
            {hostPublishing ? "OPENING CAMERA…" : hostAnglePublished ? "HOST ANGLE LIVE" : "ADD HOST CAMERA"}
          </button>
          <button className={`dock-button mode-control ${directorAuto ? "auto" : "manual"}`} onClick={toggleDirectorAuto}>
            <b>{directorAuto ? "AUTO DIRECTOR ON" : "MANUAL CONTROL"}</b>
            <small>{directorAuto ? "Tap to hold" : "Tap to automate"}</small>
          </button>
          <button className="dock-button vision-control" onClick={() => void runVisionTake()} disabled={visionBusy || feeds.length === 0 || !showLive}>{visionBusy ? "AI SEEING ANGLES…" : !showLive ? "START FILM FOR AI" : "AI VISION TAKE"}</button>
          <button
            className="dock-button burst-control"
            onClick={() => void triggerBurst()}
            disabled={crowdCameraCount === 0 || burstPending || !showLive}
            title={crowdCameraCount === 0 ? "At least one recording crowd camera is required." : "Cue the same Burst instant on every recording phone."}
          >
            {burstPending ? `BURST IN ${Math.max(burstCountdown, 1)}…` : "BURST ALL ANGLES"}
          </button>
        </div>
      </section>
    </main>
  );
}
