import type { LiveMediaStatus } from "./types";

export interface LiveKitConnectOptions {
  url: string;
  token: string;
  roomName: string;
  participantId: string;
}

export interface RemoteCameraTrack {
  cameraId: string;
  participantId: string;
  stream: MediaStream;
  track: MediaStreamTrack;
}

export type LiveMediaStatusListener = (
  status: LiveMediaStatus,
  error?: Error,
) => void;
export type RemoteTrackListener = (
  event: "subscribed" | "unsubscribed",
  track: RemoteCameraTrack,
) => void;

export interface LiveMediaAdapter {
  readonly status: LiveMediaStatus;
  readonly configured: boolean;
  connect(options: LiveKitConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  publishCamera(stream: MediaStream, cameraId: string): Promise<void>;
  unpublishCamera(cameraId: string): Promise<void>;
  setPreferredQuality(cameraId: string, quality: "low" | "medium" | "high"): void;
  onStatus(listener: LiveMediaStatusListener): () => void;
  onRemoteTrack(listener: RemoteTrackListener): () => void;
}

export interface LiveKitRuntimeCallbacks {
  onStatus(status: Exclude<LiveMediaStatus, "unconfigured" | "idle">, error?: Error): void;
  onRemoteTrack(event: "subscribed" | "unsubscribed", track: RemoteCameraTrack): void;
}

export interface LiveKitRuntimeSession {
  publishVideoTrack(
    track: MediaStreamTrack,
    options: { cameraId: string; simulcast: boolean },
  ): Promise<void>;
  unpublishVideoTrack(cameraId: string): Promise<void>;
  setPreferredQuality(cameraId: string, quality: "low" | "medium" | "high"): void;
  close(): Promise<void>;
}

export interface LiveKitRuntimeBridge {
  connect(
    options: LiveKitConnectOptions,
    callbacks: LiveKitRuntimeCallbacks,
  ): Promise<LiveKitRuntimeSession>;
}

export class LiveMediaAdapterError extends Error {
  readonly code:
    | "unconfigured"
    | "connection-failed"
    | "publish-failed"
    | "invalid-stream";
  readonly cause?: unknown;

  constructor(
    code: LiveMediaAdapterError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "LiveMediaAdapterError";
    this.code = code;
    this.cause = cause;
  }
}

abstract class BaseLiveMediaAdapter implements LiveMediaAdapter {
  abstract readonly configured: boolean;
  protected currentStatus: LiveMediaStatus = "idle";
  protected readonly statusListeners = new Set<LiveMediaStatusListener>();
  protected readonly trackListeners = new Set<RemoteTrackListener>();

  get status(): LiveMediaStatus {
    return this.currentStatus;
  }

  abstract connect(options: LiveKitConnectOptions): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract publishCamera(stream: MediaStream, cameraId: string): Promise<void>;
  abstract unpublishCamera(cameraId: string): Promise<void>;
  abstract setPreferredQuality(
    cameraId: string,
    quality: "low" | "medium" | "high",
  ): void;

  onStatus(listener: LiveMediaStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  onRemoteTrack(listener: RemoteTrackListener): () => void {
    this.trackListeners.add(listener);
    return () => this.trackListeners.delete(listener);
  }

  protected setStatus(status: LiveMediaStatus, error?: Error): void {
    this.currentStatus = status;
    this.statusListeners.forEach((listener) => listener(status, error));
  }
}

export class UnconfiguredLiveKitAdapter extends BaseLiveMediaAdapter {
  readonly configured = false;
  protected currentStatus: LiveMediaStatus = "unconfigured";

  async connect(): Promise<void> {
    throw this.error();
  }

  async disconnect(): Promise<void> {}

  async publishCamera(): Promise<void> {
    throw this.error();
  }

  async unpublishCamera(): Promise<void> {}

  setPreferredQuality(): void {}

  private error(): LiveMediaAdapterError {
    return new LiveMediaAdapterError(
      "unconfigured",
      "Live video is not configured. Add a LiveKit URL and a server-issued participant token.",
    );
  }
}

export class LiveKitMediaAdapter extends BaseLiveMediaAdapter {
  readonly configured = true;
  private session: LiveKitRuntimeSession | null = null;
  private readonly publishedCameraIds = new Set<string>();

  constructor(private readonly bridge: LiveKitRuntimeBridge) {
    super();
  }

  async connect(options: LiveKitConnectOptions): Promise<void> {
    if (!options.url || !options.token || !options.roomName || !options.participantId) {
      throw new LiveMediaAdapterError(
        "connection-failed",
        "LiveKit connection requires URL, token, room name, and participant identity.",
      );
    }
    if (this.session && this.status === "connected") return;
    if (this.session) {
      await this.session.close();
      this.session = null;
      this.publishedCameraIds.clear();
    }
    this.setStatus(this.status === "disconnected" ? "reconnecting" : "connecting");
    try {
      this.session = await this.bridge.connect(options, {
        onStatus: (status, error) => this.setStatus(status, error),
        onRemoteTrack: (event, track) =>
          this.trackListeners.forEach((listener) => listener(event, track)),
      });
      this.setStatus("connected");
    } catch (cause) {
      const error = new LiveMediaAdapterError(
        "connection-failed",
        "Could not connect this camera to the live production.",
        cause,
      );
      this.setStatus("failed", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.publishedCameraIds.clear();
    if (session) await session.close();
    this.setStatus("disconnected");
  }

  async publishCamera(stream: MediaStream, cameraId: string): Promise<void> {
    const session = this.requireSession();
    const track = stream.getVideoTracks().find((candidate) => candidate.readyState === "live");
    if (!track) {
      throw new LiveMediaAdapterError(
        "invalid-stream",
        "Cannot publish a camera without a live video track.",
      );
    }
    if (this.publishedCameraIds.has(cameraId)) return;
    try {
      // Only video is published. Any microphone track remains local for the
      // owner's original recording, preventing multi-phone audio echo.
      await session.publishVideoTrack(track, { cameraId, simulcast: true });
      this.publishedCameraIds.add(cameraId);
    } catch (cause) {
      throw new LiveMediaAdapterError(
        "publish-failed",
        "The original recording is safe, but this angle could not enter the live film.",
        cause,
      );
    }
  }

  async unpublishCamera(cameraId: string): Promise<void> {
    if (!this.session || !this.publishedCameraIds.has(cameraId)) return;
    await this.session.unpublishVideoTrack(cameraId);
    this.publishedCameraIds.delete(cameraId);
  }

  setPreferredQuality(
    cameraId: string,
    quality: "low" | "medium" | "high",
  ): void {
    this.session?.setPreferredQuality(cameraId, quality);
  }

  private requireSession(): LiveKitRuntimeSession {
    if (!this.session || this.status !== "connected") {
      throw new LiveMediaAdapterError(
        "connection-failed",
        "Connect to the LiveKit room before publishing a camera.",
      );
    }
    return this.session;
  }
}

export function createLiveMediaAdapter(
  bridge?: LiveKitRuntimeBridge | null,
): LiveMediaAdapter {
  return bridge ? new LiveKitMediaAdapter(bridge) : new UnconfiguredLiveKitAdapter();
}

export const unconfiguredLiveMediaAdapter: LiveMediaAdapter =
  new UnconfiguredLiveKitAdapter();

/**
 * Minimal structural types used to bind the official `livekit-client` SDK
 * without making browser-native recording depend on that package. The root
 * application can pass the imported SDK object into this bridge.
 */
interface LiveKitRoomLike {
  localParticipant: {
    publishTrack(
      track: MediaStreamTrack,
      options: Record<string, unknown>,
    ): Promise<{ trackSid?: string }>;
    unpublishTrack(track: MediaStreamTrack, stopOnUnpublish?: boolean): Promise<void>;
  };
  on(event: string, listener: (...args: unknown[]) => void): LiveKitRoomLike;
  connect(url: string, token: string): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void> | void;
}

interface LiveKitSdkLike {
  Room: new (options?: Record<string, unknown>) => LiveKitRoomLike;
  RoomEvent: Record<string, string>;
  Track?: { Source?: { Camera?: unknown } };
  VideoQuality?: Record<"low" | "medium" | "high" | "LOW" | "MEDIUM" | "HIGH", unknown>;
}

interface LiveKitRemoteTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  setVideoQuality?(quality: unknown): void;
}

export function createLiveKitClientBridge(sdkInput: unknown): LiveKitRuntimeBridge {
  const sdk = sdkInput as LiveKitSdkLike;
  if (!sdk || typeof sdk.Room !== "function" || !sdk.RoomEvent) {
    throw new LiveMediaAdapterError(
      "unconfigured",
      "The official livekit-client SDK must be loaded before creating its media bridge.",
    );
  }
  return {
    async connect(options, callbacks) {
      const room = new sdk.Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
      });
      const localTracks = new Map<string, MediaStreamTrack>();
      const remoteTracks = new Map<string, RemoteCameraTrack>();
      const remoteQualityTargets = new Map<
        string,
        { setVideoQuality?: (quality: unknown) => void }
      >();
      const events = sdk.RoomEvent;
      const cameraName = (cameraId: string) => `manyvue-camera:${cameraId}`;
      const parseCameraId = (trackName: unknown, participantId: string) =>
        typeof trackName === "string" && trackName.startsWith("manyvue-camera:")
          ? trackName.slice("manyvue-camera:".length)
          : `${participantId}:camera`;

      room.on(events.Reconnecting ?? "reconnecting", () => callbacks.onStatus("reconnecting"));
      room.on(events.Reconnected ?? "reconnected", () => callbacks.onStatus("connected"));
      room.on(events.Disconnected ?? "disconnected", () => callbacks.onStatus("disconnected"));
      room.on(
        events.TrackSubscribed ?? "trackSubscribed",
        (...args: unknown[]) => {
          const track = args[0] as LiveKitRemoteTrackLike;
          const publication = (args[1] ?? {}) as {
            trackName?: string;
            setVideoQuality?: (quality: unknown) => void;
          };
          const participant = (args[2] ?? {}) as { identity?: string };
          if (!track?.mediaStreamTrack || track.mediaStreamTrack.kind !== "video") return;
          const participantId = participant.identity ?? "unknown-participant";
          const cameraId = parseCameraId(publication.trackName, participantId);
          const remote: RemoteCameraTrack = {
            cameraId,
            participantId,
            track: track.mediaStreamTrack,
            stream: new MediaStream([track.mediaStreamTrack]),
          };
          remoteTracks.set(cameraId, remote);
          remoteQualityTargets.set(cameraId, publication);
          callbacks.onRemoteTrack("subscribed", remote);
        },
      );
      room.on(
        events.TrackUnsubscribed ?? "trackUnsubscribed",
        (...args: unknown[]) => {
          const publication = (args[1] ?? {}) as { trackName?: string };
          const participant = (args[2] ?? {}) as { identity?: string };
          const participantId = participant.identity ?? "unknown-participant";
          const cameraId = parseCameraId(publication.trackName, participantId);
          const remote = remoteTracks.get(cameraId);
          if (remote) {
            callbacks.onRemoteTrack("unsubscribed", remote);
            remoteTracks.delete(cameraId);
            remoteQualityTargets.delete(cameraId);
          }
        },
      );

      await room.connect(options.url, options.token);

      return {
        async publishVideoTrack(track, publishOptions) {
          await room.localParticipant.publishTrack(track, {
            name: cameraName(publishOptions.cameraId),
            source: sdk.Track?.Source?.Camera,
            simulcast: publishOptions.simulcast,
          });
          localTracks.set(publishOptions.cameraId, track);
        },
        async unpublishVideoTrack(cameraId) {
          const track = localTracks.get(cameraId);
          if (!track) return;
          await room.localParticipant.unpublishTrack(track, false);
          localTracks.delete(cameraId);
        },
        setPreferredQuality(cameraId, quality) {
          const qualityValue =
            sdk.VideoQuality?.[quality.toUpperCase() as "LOW" | "MEDIUM" | "HIGH"] ??
            sdk.VideoQuality?.[quality] ??
            quality;
          remoteQualityTargets.get(cameraId)?.setVideoQuality?.(qualityValue);
        },
        async close() {
          await room.disconnect(false);
          localTracks.clear();
          remoteTracks.clear();
          remoteQualityTargets.clear();
        },
      };
    },
  };
}
