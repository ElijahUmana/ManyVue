"use client";

import QRCode from "qrcode";
import { ConvexClient } from "convex/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Room as LiveRoom } from "livekit-client";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DurableMediaRecorder } from "@/lib/media";

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
type HostSession = { sessionId: string; slug: string; hostCapability: string };

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
  | { type: "burst_request"; by: string; at: number; id: string }
  | { type: "burst_caught"; id: string; count: number }
  | { type: "master_audio"; url: string }
  | { type: "session_state"; state: "live" | "ended" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STAGE_ANGLES: StageAngle[] = ["LEFT", "CENTER", "RIGHT"];
const ANGLE_RANK: Record<StageAngle, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };

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

async function videoDurationMs(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("The recorded clip could not be read."));
    });
    return Math.round(video.duration * 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function contactSheet(blob: Blob, burstOffsetMs: number): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("A contact frame could not be extracted."));
    });
    const sourceWidth = video.videoWidth || 720;
    const sourceHeight = video.videoHeight || 1280;
    const frameWidth = 320;
    const frameHeight = Math.max(180, Math.round(frameWidth * (sourceHeight / sourceWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = frameWidth * 3;
    canvas.height = frameHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Contact sheet canvas is unavailable.");
    const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
    const centerSeconds = Math.max(0, Math.min(durationSeconds, burstOffsetMs / 1_000));
    const timestamps = [-1.5, 0, 1.5].map((offset) =>
      Math.max(0, Math.min(Math.max(0, durationSeconds - 0.05), centerSeconds + offset)),
    );
    for (let index = 0; index < timestamps.length; index += 1) {
      const timestamp = timestamps[index];
      if (Math.abs(video.currentTime - timestamp) > 0.01) {
        await new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error("A contact sheet frame could not be decoded."));
          video.currentTime = timestamp;
        });
      }
      context.drawImage(video, index * frameWidth, 0, frameWidth, frameHeight);
    }
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((frame) => frame ? resolve(frame) : reject(new Error("Frame encoding failed.")), "image/jpeg", .78));
  } finally {
    URL.revokeObjectURL(url);
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
  const [joinExpanded, setJoinExpanded] = useState(true);
  const [joinCopied, setJoinCopied] = useState(false);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [scene, setScene] = useState<Scene>({ layout: "hero", activeIds: [], cutAt: 0, revision: 0 });
  const [, setTransport] = useState<"idle" | "connecting" | "live" | "rehearsal" | "error">("idle");
  const [transportMessage, setTransportMessage] = useState("");
  const [showLive, setShowLive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [selectedLive, setSelectedLive] = useState(false);
  const [burst, setBurst] = useState<{ id: string; at: number; count: number } | null>(null);
  const [ownedBurst, setOwnedBurst] = useState<{ id: string; at: number; count: number } | null>(null);
  const [burstPending, setBurstPending] = useState(false);
  const [clipUrl, setClipUrl] = useState("");
  const [uploadState, setUploadState] = useState<"idle" | "queued" | "uploading" | "uploaded" | "failed">("idle");
  const [artifactUrl, setArtifactUrl] = useState("");
  const [artifactMessage, setArtifactMessage] = useState("");
  const [musicUrl, setMusicUrl] = useState("");
  const [masterAudioUrl, setMasterAudioUrl] = useState("");
  const [directorAuto, setDirectorAuto] = useState(true);
  const [directorDecision, setDirectorDecision] = useState("WAITING FOR REAL ANGLES");
  const [visionBusy, setVisionBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const roomRef = useRef<LiveRoom | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<DurableMediaRecorder | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const burstRestoreRef = useRef<Scene | null>(null);
  const musicFileRef = useRef<File | null>(null);
  const recordingStartedRef = useRef(0);
  const convexRef = useRef<ConvexClient | null>(null);
  const sequenceRef = useRef(0);
  const convexInitRef = useRef(false);
  const lastConvexBurstRef = useRef("");
  const renderIdRef = useRef("");
  const convexParticipantUnsubscribeRef = useRef<(() => void) | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const directorStepRef = useRef(0);

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
        const mine = message.scene.activeIds.includes(participantId);
        setSelectedLive(mine);
        if (mine && navigator.vibrate) navigator.vibrate(36);
      }, delay);
    }
    if (message.type === "burst_request" && view === "program") {
      setBurst({ id: message.id, at: message.at, count: 0 });
    }
    if (message.type === "burst_caught") {
      setBurst((current) => current?.id === message.id ? { ...current, count: message.count } : current);
      setOwnedBurst((current) => current?.id === message.id ? { ...current, count: message.count } : current);
    }
    if (message.type === "master_audio") setMasterAudioUrl(message.url);
    if (message.type === "session_state") setShowLive(message.state === "live");
  }, [participantId, view]);

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
    if (participantCapability) {
      return { id: participantId, capability: participantCapability, livekitIdentity: participantId };
    }
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
    const id = String(joined.participantId);
    const capability = joined.participantCapability;
    setParticipantId(id);
    setParticipantCapability(capability);
    setConvexSessionId(String(joined.sessionId));
    window.localStorage.setItem(`crowdcut-camera-${sessionId}`, JSON.stringify(joined));

    convexParticipantUnsubscribeRef.current?.();
    convexParticipantUnsubscribeRef.current = client.onUpdate(api.director.programState, { sessionSlug: sessionId }, (state) => {
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
      }
      if (
        sharedBurst &&
        String(sharedBurst._id) !== lastConvexBurstRef.current &&
        sharedBurst.expectedParticipantIds.map(String).includes(id)
      ) {
        lastConvexBurstRef.current = String(sharedBurst._id);
        setBurst({ id: String(sharedBurst._id), at: sharedBurst.anchorServerMs, count: sharedBurst.readyContributionCount });
        const localStart = Math.max(0, sharedBurst.windowStartServerMs - recordingStartedRef.current);
        const localEnd = Math.max(localStart + 1, sharedBurst.windowEndServerMs - recordingStartedRef.current);
        void client.mutation(api.bursts.acknowledgePreserved, {
          participantId: joined.participantId as Id<"participants">,
          participantCapability: capability,
          burstId: sharedBurst._id,
          preservedStartMs: localStart,
          preservedEndMs: localEnd,
        });
      }
    });
    sequenceRef.current += 1;
    await client.mutation(api.participants.beginRecording, {
      participantId: joined.participantId as Id<"participants">,
      participantCapability: capability,
      clientSequence: sequenceRef.current,
      deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent },
    });
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    heartbeatRef.current = window.setInterval(() => {
      sequenceRef.current += 1;
      void client.mutation(api.participants.heartbeat, {
        participantId: joined.participantId as Id<"participants">,
        participantCapability: capability,
        clientSequence: sequenceRef.current,
        connectionState: navigator.onLine ? "online" : "offline",
      });
    }, 5000);
    return { id, capability, livekitIdentity: joined.livekitIdentity };
  }, [applyMessage, cameraAngle, participantCapability, participantId, participantName, sessionId]);

  const registerRoomListeners = useCallback(async (room: LiveRoom, role: "program" | "camera") => {
    const livekit = await import("livekit-client");
    room.on(livekit.RoomEvent.DataReceived, (payload: Uint8Array) => {
      try { applyMessage(JSON.parse(decoder.decode(payload)) as WireMessage); } catch { /* invalid packets are ignored */ }
    });

    if (role === "program") {
      const addTrack = (track: { kind: string; mediaStreamTrack: MediaStreamTrack }, participant: { identity: string; name?: string }) => {
        if (track.kind !== livekit.Track.Kind.Video) return;
        setFeeds((current) => {
          const angle = inferStageAngle(participant.identity, participant.name);
          const next: Feed = {
            id: participant.identity,
            angle,
            label: shortCameraLabel(participant.identity, participant.name, angle),
            stream: new MediaStream([track.mediaStreamTrack]),
            joinedAt: Date.now(),
          };
          return [...current.filter((item) => item.id !== next.id), next];
        });
      };
      room.on(livekit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== livekit.Track.Kind.Video) return;
        // This program view currently attaches the underlying MediaStreamTrack directly.
        // Explicitly request the top simulcast layer so the full-screen film never gets
        // stranded on LiveKit's thumbnail-quality adaptive layer.
        publication.setVideoQuality(livekit.VideoQuality.HIGH);
        publication.setVideoFPS(30);
        addTrack(track, participant);
      });
      room.on(livekit.RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => {
        setFeeds((current) => current.filter((feed) => feed.id !== participant.identity));
      });
      room.on(livekit.RoomEvent.ParticipantDisconnected, (participant) => {
        setFeeds((current) => current.filter((feed) => feed.id !== participant.identity));
      });
    }
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

  const putAsset = useCallback(async (
    file: File,
    kind: string,
    durationMs = 0,
    burstOffsetMs = 0,
    burstId?: string,
  ) => {
    const form = new FormData();
    form.set("session", sessionId);
    form.set("participant", participantId);
    form.set("kind", kind);
    form.set("durationMs", String(durationMs));
    form.set("burstOffsetMs", String(burstOffsetMs));
    if (burstId) form.set("burstId", burstId);
    form.set("file", file);
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    const result = await response.json() as { ok?: boolean; url?: string; error?: string };
    if (!response.ok || !result.ok || !result.url) throw new Error(result.error || "Media upload failed");
    return result.url;
  }, [participantId, sessionId]);

  const buildArtifact = useCallback(async () => {
    if (!ownedBurst) {
      setArtifactMessage("Your original angle is safe. Tap Burst while recording to create a multi-angle cut.");
      return;
    }
    setUploadState("queued");
    setArtifactMessage(renderIdRef.current
      ? "Checking the production render…"
      : "Waiting for real crowd angles…");
    try {
      let renderId = renderIdRef.current;
      if (!renderId) {
        type RemoteAsset = {
          url: string;
          uploaded: string;
          metadata: Record<string, string>;
        };
        let assets: RemoteAsset[] = [];
        let effectiveMasterAudioUrl = masterAudioUrl;
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const listed = await fetch(`/api/uploads?list=1&session=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
          if (!listed.ok) throw new Error(`Uploaded media listing failed (${listed.status}).`);
          const body = await listed.json() as { assets?: RemoteAsset[] };
          assets = body.assets || [];
          effectiveMasterAudioUrl ||= assets
            .filter((asset) => asset.metadata.kind === "master-audio")
            .sort((left, right) => right.uploaded.localeCompare(left.uploaded))[0]?.url || "";
          const contributors = new Set(
            assets
              .filter((asset) => asset.metadata.kind === "burst-source" && asset.metadata.burstId === ownedBurst.id)
              .map((asset) => asset.metadata.participant),
          );
          if (contributors.size >= 2 && effectiveMasterAudioUrl) break;
          await wait(1_200);
        }

        const grouped = new Map<string, { clip?: RemoteAsset; thumbnail?: RemoteAsset }>();
        const burstAssets = assets
          .filter((asset) => asset.metadata.burstId === ownedBurst.id)
          .sort((left, right) => left.uploaded.localeCompare(right.uploaded));
        for (const asset of burstAssets) {
          const camera = asset.metadata.participant;
          if (!camera) continue;
          const current = grouped.get(camera) || {};
          if (asset.metadata.kind === "burst-source") current.clip = asset;
          if (asset.metadata.kind === "thumbnail") current.thumbnail = asset;
          grouped.set(camera, current);
        }
        const candidates = [...grouped.entries()].flatMap(([cameraId, pair]) => {
          const durationMs = Number(pair.clip?.metadata.durationMs || 0);
          const burstOffsetMs = Number(pair.clip?.metadata.burstOffsetMs || 0);
          if (!pair.clip || !pair.thumbnail || durationMs < 5_000 || burstOffsetMs < 0 || burstOffsetMs > durationMs) return [];
          return [{
            id: `${cameraId}-source`,
            cameraId,
            clipUrl: pair.clip.url,
            contactSheetUrl: pair.thumbnail.url,
            availableDurationMs: durationMs,
            burstOffsetMs,
            qualityScore: cameraId === participantId ? .92 : .82,
          }];
        });
        if (candidates.length < 2 || !candidates.some((candidate) => candidate.cameraId === participantId)) {
          setArtifactMessage("Waiting for at least two uploaded Burst angles, including yours. Stop the other cameras, then tap Build again.");
          return;
        }
        if (!effectiveMasterAudioUrl) {
          setUploadState("failed");
          setArtifactMessage("The real master track is not uploaded, so no cinematic artifact was fabricated.");
          return;
        }

        const editInput = {
          artifactId: `burst-${ownedBurst.id}`,
          ownerCameraId: participantId,
          durationMs: Math.min(12_000, Math.max(8_000, Math.min(...candidates.map((candidate) => candidate.availableDurationMs)))),
          candidates,
        };
        setArtifactMessage("Choosing a truthful cut from the uploaded perspectives…");
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
          body: JSON.stringify({ editInput, recipe, masterAudioUrl: effectiveMasterAudioUrl }),
        });
        const queued = await artifactResponse.json() as { state?: string; renderId?: string; reason?: string; missing?: string[] };
        if (!artifactResponse.ok || queued.state !== "queued" || !queued.renderId) {
          setUploadState("failed");
          setArtifactMessage(queued.reason || `Production renderer is not ready${queued.missing?.length ? `: ${queued.missing.join(", ")}` : "."}`);
          return;
        }
        renderId = queued.renderId;
        renderIdRef.current = renderId;
      }

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
          setArtifactMessage("Your shareable CrowdCut is ready — every angle is real.");
          renderIdRef.current = "";
          return;
        }
        if (status.render?.status === "failed") throw new Error(status.reason || "The production render failed.");
      }
      setArtifactMessage("The production render is still processing. Tap Check render to continue watching it.");
    } catch (error) {
      setUploadState("failed");
      setArtifactMessage(error instanceof Error ? error.message : "The cinematic render failed; your original remains safe.");
      renderIdRef.current = "";
    }
  }, [masterAudioUrl, ownedBurst, participantId, sessionId]);

  const uploadClip = useCallback(async (blob: Blob) => {
    setUploadState("uploading");
    setArtifactMessage("Uploading your real source recording…");
    try {
      const durationMs = await videoDurationMs(blob);
      const contributionBurst = ownedBurst ?? burst;
      const burstOffsetMs = contributionBurst
        ? Math.max(0, contributionBurst.at - recordingStartedRef.current)
        : Math.floor(durationMs / 2);
      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      await putAsset(
        new File([blob], `crowdcut-${participantId}.${extension}`, { type: blob.type }),
        contributionBurst ? "burst-source" : "original",
        durationMs,
        burstOffsetMs,
        contributionBurst?.id,
      );
      const sheet = await contactSheet(blob, burstOffsetMs);
      await putAsset(
        new File([sheet], `crowdcut-${participantId}-contact-sheet.jpg`, { type: "image/jpeg" }),
        "thumbnail",
        durationMs,
        burstOffsetMs,
        contributionBurst?.id,
      );
      setUploadState("uploaded");
      if (ownedBurst) await buildArtifact();
      else setArtifactMessage(contributionBurst
        ? "Your angle joined the real Crowd Burst. The initiator is assembling the shared cut."
        : "Your original recording is uploaded and remains available on this device.");
    } catch (error) {
      setUploadState("failed");
      setArtifactMessage(error instanceof Error ? error.message : "Upload failed; your original remains safe on this device.");
    }
  }, [buildArtifact, burst, ownedBurst, participantId, putAsset]);

  const startCamera = useCallback(async () => {
    setTransportMessage("Opening your angle…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setCameraStream(stream);
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
      recordingStartedRef.current = Date.now();
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
      setUploadState("queued");
      void uploadClip(result.blob);
    }
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
  }, [cameraStream, participantCapability, participantId, uploadClip]);

  const triggerBurst = useCallback(async () => {
    if (!recording || burstPending) return;
    setBurstPending(true);
    const markerId = crypto.randomUUID();
    if (navigator.vibrate) navigator.vibrate([32, 24, 64]);
    try {
      if (convexRef.current && participantCapability) {
        const result = await convexRef.current.mutation(api.bursts.trigger, {
          participantId: participantId as Id<"participants">,
          participantCapability,
          clientMarkerId: markerId,
          clientObservedAtMs: Date.now(),
        });
        if (result.burst) {
          const marker = { id: String(result.burst._id), at: result.burst.anchorServerMs, count: result.burst.readyContributionCount };
          lastConvexBurstRef.current = marker.id;
          setBurst(marker);
          setOwnedBurst(marker);
          const localStart = Math.max(0, result.burst.windowStartServerMs - recordingStartedRef.current);
          const localEnd = Math.max(localStart + 1, result.burst.windowEndServerMs - recordingStartedRef.current);
          await convexRef.current.mutation(api.bursts.acknowledgePreserved, {
            participantId: participantId as Id<"participants">,
            participantCapability,
            burstId: result.burst._id,
            preservedStartMs: localStart,
            preservedEndMs: localEnd,
          });
        }
        return;
      }
      const marker = { id: markerId, at: Date.now(), count: 1 };
      setBurst(marker);
      setOwnedBurst(marker);
      await send({ type: "burst_request", by: participantId, at: marker.at, id: marker.id });
    } catch (error) {
      setTransportMessage(error instanceof Error ? error.message : "Crowd Burst could not be captured.");
      if (navigator.vibrate) navigator.vibrate([90, 45, 90]);
    } finally {
      setBurstPending(false);
    }
  }, [burstPending, participantCapability, participantId, recording, send]);

  const commitScene = useCallback(async (
    activeIds: string[],
    layout: SceneLayout,
    reason?: string,
    sourceOverride?: "manual" | "deterministic" | "ai",
  ) => {
    const next: Scene = {
      layout,
      activeIds,
      cutAt: Date.now() + 600,
      revision: scene.revision + 1,
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
  }, [applyMessage, convexSessionId, directorAuto, hostCapability, scene.revision, send]);

  const startProgram = useCallback(async () => {
    await connectTransport("program");
    if (convexRef.current && convexSessionId && hostCapability) {
      await convexRef.current.mutation(api.sessions.startLive, {
        sessionId: convexSessionId as Id<"sessions">,
        hostCapability,
      });
    }
    if (musicFileRef.current && !masterAudioUrl) {
      try {
        const uploadedAudio = await putAsset(musicFileRef.current, "master-audio");
        setMasterAudioUrl(uploadedAudio);
        await send({ type: "master_audio", url: uploadedAudio });
      } catch {
        setTransportMessage("The live film can run, but the master track upload failed.");
      }
    }
    setShowLive(true);
    setJoinExpanded(false);
    setElapsed(0);
    await send({ type: "session_state", state: "live" });
    if (audioRef.current && musicUrl) await audioRef.current.play().catch(() => undefined);
  }, [connectTransport, convexSessionId, hostCapability, masterAudioUrl, musicUrl, putAsset, send]);

  const publishHostAngle = useCallback(async () => {
    try {
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
      recordingStartedRef.current = Date.now();
      setRecording(true);
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
    }
  }, [connectTransport, participantCapability, participantId]);

  useEffect(() => {
    if (!showLive) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [showLive]);

  const orderedFeeds = useMemo(() => orderedByStage(feeds), [feeds]);

  const takeFeed = useCallback((feed: Feed) => {
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL TAKE · ${feed.angle} · ${feed.label}`);
    void commitScene(
      [feed.id],
      "hero",
      `Manual full-screen TAKE from the ${feed.angle.toLowerCase()} stage angle`,
    ).catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The camera TAKE failed.");
    });
  }, [commitScene]);

  const takeDuo = useCallback(() => {
    const directed = stageAwareDirectorScene(feeds, 2);
    const pair = directed.feeds.slice(0, 2);
    if (!pair.length) return;
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL DUO · ${pair.map((feed) => feed.angle).join(" + ")}`);
    void commitScene(
      pair.map((feed) => feed.id),
      pair.length > 1 ? "duo" : "hero",
      `Manual complementary-angle DUO: ${pair.map((feed) => feed.angle).join(" + ")}`,
    ).catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The DUO TAKE failed.");
    });
  }, [commitScene, feeds]);

  const takeSweep = useCallback(() => {
    const sweep = orderedByStage(feeds).slice(0, 6);
    if (!sweep.length) return;
    setDirectorAuto(false);
    setDirectorDecision(`MANUAL SWEEP · ${sweep.map((feed) => feed.angle).join(" → ")}`);
    void commitScene(
      sweep.map((feed) => feed.id),
      sweep.length > 1 ? "sweep" : "hero",
      `Manual stage-relative SWEEP: ${sweep.map((feed) => feed.angle).join(" → ")}`,
    ).catch((error) => {
      setTransportMessage(error instanceof Error ? error.message : "The SWEEP TAKE failed.");
    });
  }, [commitScene, feeds]);

  const toggleDirectorAuto = useCallback(() => {
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
    if (view !== "program" || !showLive || !directorAuto || feeds.length === 0 || burst) return;
    const timer = window.setInterval(() => {
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
      const directed = stageAwareDirectorScene(feeds, directorStepRef.current);
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
    }, 3600);
    return () => window.clearInterval(timer);
  }, [burst, commitScene, convexSessionId, directorAuto, feeds, hostCapability, showLive, view]);

  useEffect(() => {
    if (view !== "program" || !burst || feeds.length === 0) return;
    if (!burstRestoreRef.current) burstRestoreRef.current = scene;
    const ids = orderedByStage(feeds).slice(0, 6).map((feed) => feed.id);
    queueMicrotask(() => {
      setDirectorDecision(
        `BURST SWEEP · ${orderedByStage(feeds).slice(0, 6).map((feed) => feed.angle).join(" → ")}`,
      );
    });
    void commitScene(
      ids,
      ids.length > 1 ? "sweep" : "hero",
      "Crowd Burst stage-relative perspective sweep",
    );
    void send({ type: "burst_caught", id: burst.id, count: ids.length });
    const timer = window.setTimeout(() => {
      const restore = burstRestoreRef.current;
      burstRestoreRef.current = null;
      setBurst(null);
      if (restore) void commitScene(restore.activeIds, restore.layout, "Restore pre-Burst program scene");
    }, 3200);
    return () => window.clearTimeout(timer);
    // Burst is intentionally a single scheduled production moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burst?.id, feeds.length, view]);

  useEffect(() => () => {
    roomRef.current?.disconnect();
    cameraStream?.getTracks().forEach((track) => track.stop());
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    if (musicUrl) URL.revokeObjectURL(musicUrl);
  }, [cameraStream, clipUrl, musicUrl]);

  const activeFeeds = useMemo(() => {
    const selected = scene.activeIds.map((id) => feeds.find((feed) => feed.id === id)).filter(Boolean) as Feed[];
    const directedFallback = stageAwareDirectorScene(orderedFeeds, 0).feeds;
    return selected.length
      ? selected
      : directedFallback.slice(0, scene.layout === "duo" ? 2 : 1);
  }, [feeds, orderedFeeds, scene.activeIds, scene.layout]);

  if (view === "camera") {
    return (
      <main className={`camera-shell ${selectedLive ? "is-live" : ""}`}>
        <video ref={previewRef} className="camera-preview" autoPlay muted playsInline />
        {!cameraStream && <div className="camera-aurora" aria-hidden="true" />}
        <header className="camera-topbar">
          <BrandMark />
          <StatusPill tone={selectedLive ? "live" : recording ? "ready" : "warn"}>
            {selectedLive ? "YOUR ANGLE IS LIVE" : recording ? "RECORDING" : "READY"}
          </StatusPill>
        </header>

        {!recording && !clipUrl && (
          <section className="camera-intro">
            <p className="eyebrow">YOU ARE THE CAMERA</p>
            <h1>Record your angle.<br /><em>Take home the crowd.</em></h1>
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
            <div className="recording-readout"><i /> {cameraAngle} ANGLE · LIVE READY <b>{String(elapsed).padStart(2, "0")}s</b></div>
            <button className={`burst-trigger ${ownedBurst ? "caught" : ""}`} onClick={triggerBurst} disabled={burstPending}>
              <span className="burst-rings" aria-hidden="true"><i /><i /></span>
              <b>{burstPending ? "CATCHING EVERY ANGLE…" : ownedBurst ? "BURST CAUGHT · TAP FOR ANOTHER" : "BURST THIS MOMENT"}</b>
              <small>{ownedBurst ? `${Math.max(1, ownedBurst.count)} angles captured your moment` : "Keep filming — the crowd captures every angle"}</small>
            </button>
            <button className="stop-trigger" onClick={stopCamera}>Stop & build my CrowdCut</button>
          </section>
        )}

        {clipUrl && !recording && (
          <section className="artifact-card">
            <p className="eyebrow">YOUR MOMENT IS REAL</p>
            <h2>{artifactUrl ? "Your CrowdCut is ready." : "Your angle is safe."}</h2>
            <video src={artifactUrl || clipUrl} controls playsInline />
            <div className="artifact-actions">
              <a href={artifactUrl || clipUrl} download={artifactUrl ? "my-crowdcut.mp4" : "my-angle.webm"}>Save video</a>
              {ownedBurst && !artifactUrl && (
                <button onClick={() => void buildArtifact()}>
                  {uploadState === "queued" ? "Check render" : "Build from uploaded angles"}
                </button>
              )}
              <button onClick={() => {
                setClipUrl("");
                setArtifactUrl("");
                setArtifactMessage("");
                setBurst(null);
                setOwnedBurst(null);
                setUploadState("idle");
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
          <article className={`program-feed feed-${index + 1}`} key={feed.id}>
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
            <p className="eyebrow">OUTSIDE LANDS · LIVE CAMERA CREW</p>
            <h1>THE CROWD<br />IS THE <em>CAMERA.</em></h1>
            <p>Every phone becomes an angle. Every angle becomes the film.</p>
          </div>
        )}

        {burst && (
          <div className="burst-overlay">
            <span className="burst-word">CROWD</span><span className="burst-word alt">BURST</span>
            <p>{Math.max(burst.count, activeFeeds.length)} REAL PERSPECTIVES · ONE MOMENT</p>
          </div>
        )}

        <header className="program-topbar">
          <BrandMark />
          <div className="program-status">
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
          {!joinExpanded && <button className="join-expand" onClick={() => setJoinExpanded(true)}>ENLARGE QR</button>}
        </aside>

        {feeds.length > 0 && (
          <aside className="multiview-rail" aria-label="Live camera multiview">
            <header>
              <div><span className="live-dot" /> MULTIVIEW</div>
              <b>{STAGE_ANGLES.map((angle) => `${angle[0]}:${feeds.filter((feed) => feed.angle === angle).length}`).join(" · ")}</b>
            </header>
            <div className="multiview-grid">
              {orderedFeeds.slice(0, 8).map((feed, index) => {
                const onAir = scene.activeIds.includes(feed.id) || (!scene.activeIds.length && index === 0);
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
              })}
            </div>
            <div className="layout-controls" aria-label="Program layouts">
              <button onClick={() => { const target = activeFeeds[0] ?? orderedFeeds[0]; if (target) takeFeed(target); }}>HERO</button>
              <button disabled={feeds.length < 2} onClick={takeDuo}>DUO</button>
              <button disabled={feeds.length < 2} onClick={takeSweep}>CROWD SWEEP</button>
            </div>
          </aside>
        )}

        <footer className="program-footer">
          <div className="angle-count"><b>{feeds.length}</b><span>CONNECTED CAMERAS</span></div>
          <div className="director-label">
            <span>AI DIRECTOR</span>
            <b>{directorAuto ? "AUTO" : "MANUAL"}</b>
            <em>{directorDecision}</em>
          </div>
        </footer>
      </section>

      <section className="director-dock" aria-label="CrowdCut production controls">
        <div className="dock-copy">
          <p className="eyebrow">LIVE PRODUCTION</p>
          <h2>{showLive ? directorDecision : "Ready to turn the room into a camera."}</h2>
          <p>{transportMessage || "Connect the program, publish your host angle, then let the crowd join."}</p>
        </div>
        <div className="dock-controls">
          <label className="file-control">
            <span>{musicUrl ? "TRACK LOADED" : "LOAD MASTER TRACK"}</span>
            <input type="file" accept="audio/*" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                musicFileRef.current = file;
                setMusicUrl((current) => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file); });
              }
            }} />
          </label>
          <button className="dock-button secondary" onClick={publishHostAngle}>Publish host angle</button>
          <button className="dock-button secondary" onClick={toggleDirectorAuto}>{directorAuto ? "Take manual control" : "Resume AI director"}</button>
          <button className="dock-button vision-control" onClick={() => void runVisionTake()} disabled={visionBusy || feeds.length === 0}>{visionBusy ? "AI seeing angles…" : "AI vision take"}</button>
          <button className="dock-button burst-control" onClick={() => void triggerBurst()} disabled={!recording || feeds.length === 0 || burstPending}>{burstPending ? "Catching burst…" : "Burst all angles"}</button>
          <button className="dock-button primary" onClick={startProgram}>{showLive ? "Program running" : "Start live film"}</button>
        </div>
        {musicUrl && <audio ref={audioRef} src={musicUrl} onEnded={() => { setShowLive(false); void send({ type: "session_state", state: "ended" }); }} />}
      </section>
    </main>
  );
}
