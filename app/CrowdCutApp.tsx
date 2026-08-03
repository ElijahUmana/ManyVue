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
  stream: MediaStream;
  local?: boolean;
  joinedAt: number;
};

type SceneLayout = "hero" | "duo" | "sweep";
type HostSession = { sessionId: string; slug: string; hostCapability: string };

type Scene = {
  layout: SceneLayout;
  activeIds: string[];
  cutAt: number;
  revision: number;
};

type WireMessage =
  | { type: "scene"; scene: Scene }
  | { type: "burst_request"; by: string; at: number; id: string }
  | { type: "burst_caught"; id: string; count: number }
  | { type: "master_audio"; url: string }
  | { type: "session_state"; state: "live" | "ended" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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

async function posterFrame(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("A contact frame could not be extracted."));
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(320, Math.min(720, video.videoWidth || 720));
    canvas.height = Math.round(canvas.width * ((video.videoHeight || 1280) / (video.videoWidth || 720)));
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
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

  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={`${feed.label} live camera`} />;
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
  const [musicUrl, setMusicUrl] = useState("");
  const [masterAudioUrl, setMasterAudioUrl] = useState("");
  const [directorAuto, setDirectorAuto] = useState(true);
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
  const convexParticipantUnsubscribeRef = useRef<(() => void) | null>(null);
  const heartbeatRef = useRef<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextView = params.get("view") === "camera" ? "camera" : "program";
    const nextSession = params.get("session") || "outside-live";
    const stored = window.localStorage.getItem("crowdcut-participant") || crypto.randomUUID();
    window.localStorage.setItem("crowdcut-participant", stored);
    queueMicrotask(() => {
      setView(nextView);
      setSessionId(nextSession);
      setParticipantId(stored);
      setParticipantName(nextView === "program" ? "Program" : `Angle ${stored.slice(0, 4).toUpperCase()}`);
      setBooted(true);
    });
  }, []);

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
            },
          });
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
  }, [applyMessage, participantCapability, participantId, participantName, sessionId]);

  const registerRoomListeners = useCallback(async (room: LiveRoom, role: "program" | "camera") => {
    const livekit = await import("livekit-client");
    room.on(livekit.RoomEvent.DataReceived, (payload: Uint8Array) => {
      try { applyMessage(JSON.parse(decoder.decode(payload)) as WireMessage); } catch { /* invalid packets are ignored */ }
    });

    if (role === "program") {
      const addTrack = (track: { kind: string; mediaStreamTrack: MediaStreamTrack }, participant: { identity: string; name?: string }) => {
        if (track.kind !== livekit.Track.Kind.Video) return;
        setFeeds((current) => {
          const next: Feed = {
            id: participant.identity,
            label: participant.name || `Angle ${participant.identity.slice(0, 4).toUpperCase()}`,
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

  const putAsset = useCallback(async (file: File, kind: string, durationMs = 0, burstOffsetMs = 0) => {
    const form = new FormData();
    form.set("session", sessionId);
    form.set("participant", participantId);
    form.set("kind", kind);
    form.set("durationMs", String(durationMs));
    form.set("burstOffsetMs", String(burstOffsetMs));
    form.set("file", file);
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    const result = await response.json() as { ok?: boolean; url?: string; error?: string };
    if (!response.ok || !result.ok || !result.url) throw new Error(result.error || "Media upload failed");
    return result.url;
  }, [participantId, sessionId]);

  const uploadClip = useCallback(async (blob: Blob) => {
    setUploadState("uploading");
    try {
      const durationMs = await videoDurationMs(blob);
      const burstOffsetMs = ownedBurst ? Math.max(0, ownedBurst.at - recordingStartedRef.current) : Math.floor(durationMs / 2);
      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      await putAsset(new File([blob], `crowdcut-${participantId}.${extension}`, { type: blob.type }), ownedBurst ? "burst-source" : "original", durationMs, burstOffsetMs);
      const frame = await posterFrame(blob);
      await putAsset(new File([frame], `crowdcut-${participantId}.jpg`, { type: "image/jpeg" }), "thumbnail", durationMs, burstOffsetMs);
      setUploadState("uploaded");

      if (!ownedBurst || !masterAudioUrl || durationMs < 8_000) return;
      let assets: Array<{ url: string; metadata: Record<string, string> }> = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const listed = await fetch(`/api/uploads?list=1&session=${encodeURIComponent(sessionId)}`);
        const body = await listed.json() as { assets?: Array<{ url: string; metadata: Record<string, string> }> };
        assets = body.assets || [];
        const participants = new Set(assets.filter((asset) => asset.metadata.kind === "burst-source").map((asset) => asset.metadata.participant));
        if (participants.size >= 2) break;
        await wait(1800);
      }

      const grouped = new Map<string, { clip?: typeof assets[number]; thumbnail?: typeof assets[number] }>();
      for (const asset of assets) {
        const camera = asset.metadata.participant;
        if (!camera) continue;
        const current = grouped.get(camera) || {};
        if (asset.metadata.kind === "burst-source") current.clip = asset;
        if (asset.metadata.kind === "thumbnail") current.thumbnail = asset;
        grouped.set(camera, current);
      }
      const candidates = [...grouped.entries()].flatMap(([cameraId, pair]) => pair.clip && pair.thumbnail ? [{
        id: `${cameraId}-source`,
        cameraId,
        clipUrl: pair.clip.url,
        contactSheetUrl: pair.thumbnail.url,
        availableDurationMs: Number(pair.clip.metadata.durationMs || 0),
        burstOffsetMs: Number(pair.clip.metadata.burstOffsetMs || 0),
        qualityScore: cameraId === participantId ? .92 : .82,
      }] : []);
      if (candidates.length < 2) {
        setUploadState("queued");
        return;
      }
      const editInput = {
        artifactId: `burst-${ownedBurst.id}`,
        ownerCameraId: participantId,
        durationMs: Math.min(12_000, Math.max(8_000, Math.min(...candidates.map((candidate) => candidate.availableDurationMs)))),
        candidates,
      };
      const plannedResponse = await fetch("/api/ai/edit-recipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editInput),
      });
      const planned = await plannedResponse.json() as { recipe?: unknown; fallbackRecipe?: unknown };
      const recipe = planned.recipe || planned.fallbackRecipe;
      if (!recipe) throw new Error("No valid edit recipe was produced");
      const artifactResponse = await fetch("/api/artifacts/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ editInput, recipe, masterAudioUrl }),
      });
      const queued = await artifactResponse.json() as { state?: string; renderId?: string };
      if (!artifactResponse.ok || queued.state !== "queued" || !queued.renderId) {
        setUploadState("queued");
        return;
      }
      setUploadState("queued");
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(2500);
        const statusResponse = await fetch(`/api/artifacts/render/status?id=${encodeURIComponent(queued.renderId)}`);
        if (!statusResponse.ok) continue;
        const status = await statusResponse.json() as { state?: string; render?: { status?: string; url?: string | null } };
        if (status.render?.status === "done" && status.render.url) {
          setArtifactUrl(status.render.url);
          setUploadState("uploaded");
          break;
        }
        if (status.render?.status === "failed") {
          setUploadState("failed");
          break;
        }
      }
    } catch {
      setUploadState("failed");
    }
  }, [masterAudioUrl, ownedBurst, participantId, putAsset, sessionId]);

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
  }, [connectTransport, ensureConvexCamera, uploadClip]);

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

  const commitScene = useCallback(async (activeIds: string[], layout: SceneLayout) => {
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
        source: directorAuto ? "ai" : "manual",
        reason: directorAuto ? "Quality-aware rhythmic rotation" : "Presenter selection",
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
      const host: Feed = { id: participantId, label: "Host angle", stream, local: true, joinedAt: Date.now() };
      setFeeds((current) => [...current.filter((feed) => feed.id !== host.id), host]);
      recordingStartedRef.current = Date.now();
      setRecording(true);
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

  useEffect(() => {
    if (view !== "program" || !showLive || !directorAuto || feeds.length === 0 || burst) return;
    const timer = window.setInterval(() => {
      const ordered = [...feeds].sort((a, b) => a.joinedAt - b.joinedAt);
      const nextIndex = Math.max(0, ordered.findIndex((feed) => scene.activeIds.includes(feed.id)) + 1) % ordered.length;
      const hero = ordered[nextIndex];
      const duo = ordered[(nextIndex + 1) % ordered.length];
      const layout: SceneLayout = ordered.length > 1 && scene.revision % 3 === 2 ? "duo" : "hero";
      void commitScene(layout === "duo" ? [hero.id, duo.id] : [hero.id], layout);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [burst, commitScene, directorAuto, feeds, scene.activeIds, scene.revision, showLive, view]);

  useEffect(() => {
    if (view !== "program" || !burst || feeds.length === 0) return;
    if (!burstRestoreRef.current) burstRestoreRef.current = scene;
    const ids = feeds.slice(0, 6).map((feed) => feed.id);
    void commitScene(ids, ids.length > 1 ? "sweep" : "hero");
    void send({ type: "burst_caught", id: burst.id, count: ids.length });
    const timer = window.setTimeout(() => {
      const restore = burstRestoreRef.current;
      burstRestoreRef.current = null;
      setBurst(null);
      if (restore) void commitScene(restore.activeIds, restore.layout);
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
    return selected.length ? selected : feeds.slice(0, scene.layout === "duo" ? 2 : 1);
  }, [feeds, scene.activeIds, scene.layout]);

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
            <p>Your original stays yours. When your view enters the film, you’ll see it here.</p>
            <button className="record-trigger" onClick={startCamera}>
              <span aria-hidden="true" /> START MY ANGLE
            </button>
            {transportMessage && <p className="inline-message">{transportMessage}</p>}
          </section>
        )}

        {recording && (
          <section className="camera-controls">
            <div className="recording-readout"><i /> LIVE ANGLE <b>{String(elapsed).padStart(2, "0")}s</b></div>
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
              <a href={artifactUrl || clipUrl} download="my-crowdcut.webm">Save video</a>
              <button onClick={() => { setClipUrl(""); setArtifactUrl(""); setBurst(null); setOwnedBurst(null); setUploadState("idle"); }}>Record another</button>
            </div>
            <p className={`upload-state ${uploadState}`}>{uploadState === "uploaded" ? "Source uploaded · cinematic render requested" : uploadState === "uploading" ? "Uploading the real source…" : uploadState === "failed" ? "Upload paused — original remains on this device" : uploadState === "queued" ? "Cinematic cut is assembling…" : ""}</p>
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
            <span className="feed-label"><i /> {feed.label}</span>
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
              <b>{feeds.length} LIVE ANGLES</b>
            </header>
            <div className="multiview-grid">
              {feeds.slice(0, 8).map((feed, index) => {
                const onAir = scene.activeIds.includes(feed.id) || (!scene.activeIds.length && index === 0);
                return (
                  <button className={`multiview-card ${onAir ? "on-air" : ""}`} key={feed.id} onClick={() => { setDirectorAuto(false); void commitScene([feed.id], "hero"); }}>
                    <span className="multiview-video"><FeedVideo feed={feed} /></span>
                    <span className="multiview-meta"><b>{feed.label}</b><em>{onAir ? "ON AIR" : "TAKE"}</em></span>
                  </button>
                );
              })}
            </div>
            <div className="layout-controls" aria-label="Program layouts">
              <button onClick={() => { const target = scene.activeIds[0] || feeds[0]?.id; if (target) { setDirectorAuto(false); void commitScene([target], "hero"); } }}>HERO</button>
              <button disabled={feeds.length < 2} onClick={() => { setDirectorAuto(false); void commitScene(feeds.slice(0, 2).map((feed) => feed.id), "duo"); }}>DUO</button>
              <button disabled={feeds.length < 2} onClick={() => { setDirectorAuto(false); void commitScene(feeds.slice(0, 8).map((feed) => feed.id), "sweep"); }}>CROWD SWEEP</button>
            </div>
          </aside>
        )}

        <footer className="program-footer">
          <div className="angle-count"><b>{feeds.length}</b><span>CONNECTED CAMERAS</span></div>
          <div className="director-label"><span>AI DIRECTOR</span><b>{directorAuto ? "AUTO" : "MANUAL"}</b></div>
        </footer>
      </section>

      <section className="director-dock" aria-label="CrowdCut production controls">
        <div className="dock-copy">
          <p className="eyebrow">LIVE PRODUCTION</p>
          <h2>{showLive ? "The room is making the film." : "Ready to turn the room into a camera."}</h2>
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
          <button className="dock-button secondary" onClick={() => setDirectorAuto((current) => !current)}>{directorAuto ? "Take manual control" : "Resume AI director"}</button>
          <button className="dock-button burst-control" onClick={() => void triggerBurst()} disabled={!recording || feeds.length === 0 || burstPending}>{burstPending ? "Catching burst…" : "Burst all angles"}</button>
          <button className="dock-button primary" onClick={startProgram}>{showLive ? "Program running" : "Start live film"}</button>
        </div>
        {musicUrl && <audio ref={audioRef} src={musicUrl} onEnded={() => { setShowLive(false); void send({ type: "session_state", state: "ended" }); }} />}
      </section>
    </main>
  );
}
