import { mediaRecorderOptions, negotiateRecorderCodec } from "./codec";
import { MediaChunkStore, mediaChunkStore } from "./chunk-store";
import {
  BURST_POST_ROLL_MS,
  BURST_PRE_ROLL_MS,
  type RollingBurstCapture,
} from "./rolling-burst-recorder";
import type { StoredMediaChunk, StoredRecording } from "./types";

export type FrameRingEntry = {
  capturedAtMs: number;
  blob: Blob;
};

export type FrameRingBurstRecorderOptions = {
  participantId: string;
  frameRate?: number;
  maxLongEdge?: number;
  jpegQuality?: number;
  store?: MediaChunkStore;
  now?: () => number;
  onError?: (error: Error) => void;
};

const wait = (delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, delayMs)));
export const FRAME_RING_RETENTION_MARGIN_MS = 1_500;

export function frameRingRetentionCutoff(
  capturedAtMs: number,
  preRollMs = BURST_PRE_ROLL_MS,
  postRollMs = BURST_POST_ROLL_MS,
  marginMs = FRAME_RING_RETENTION_MARGIN_MS,
) {
  return capturedAtMs - preRollMs - postRollMs - marginMs;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 72) || "camera";
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.size) resolve(blob);
      else reject(new Error("The browser could not retain a local Burst frame."));
    }, "image/jpeg", quality);
  });
}

function canvasSize(width: number, height: number, maxLongEdge: number) {
  const safeWidth = Math.max(2, width || 1280);
  const safeHeight = Math.max(2, height || 960);
  const scale = Math.min(1, maxLongEdge / Math.max(safeWidth, safeHeight));
  const even = (value: number) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(safeWidth), height: even(safeHeight) };
}

export function sampleFrameRingWindow<T extends { capturedAtMs: number }>(
  frames: readonly T[],
  anchorMs: number,
  preRollMs = BURST_PRE_ROLL_MS,
  postRollMs = BURST_POST_ROLL_MS,
  frameRate = 12,
): T[] | null {
  const ordered = [...frames].sort((left, right) => left.capturedAtMs - right.capturedAtMs);
  const startMs = anchorMs - preRollMs;
  const endMs = anchorMs + postRollMs;
  if (
    !ordered.length ||
    ordered[0].capturedAtMs > startMs ||
    ordered[ordered.length - 1].capturedAtMs < endMs ||
    !Number.isFinite(frameRate) ||
    frameRate < 1
  ) return null;

  const relevant = ordered.filter((frame) =>
    frame.capturedAtMs >= startMs - 500 && frame.capturedAtMs <= endMs + 500,
  );
  if (relevant.length < 2) return null;
  for (let index = 1; index < relevant.length; index += 1) {
    if (relevant[index].capturedAtMs - relevant[index - 1].capturedAtMs > 750) return null;
  }

  const intervalMs = 1_000 / frameRate;
  const samples: T[] = [];
  let frameIndex = 0;
  for (let targetMs = startMs; targetMs <= endMs + intervalMs / 2; targetMs += intervalMs) {
    while (
      frameIndex + 1 < ordered.length &&
      Math.abs(ordered[frameIndex + 1].capturedAtMs - targetMs) <=
        Math.abs(ordered[frameIndex].capturedAtMs - targetMs)
    ) frameIndex += 1;
    samples.push(ordered[frameIndex]);
  }
  return samples;
}

async function drawBlobFrame(
  context: CanvasRenderingContext2D,
  blob: Blob,
  width: number,
  height: number,
) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      context.drawImage(bitmap, 0, 0, width, height);
    } finally {
      bitmap.close();
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function persistStandaloneBurst(
  store: MediaChunkStore,
  recordingId: string,
  participantId: string,
  blob: Blob,
  startedAtMs: number,
  endedAtMs: number,
) {
  const now = Date.now();
  const recording: StoredRecording = {
    id: recordingId,
    participantId,
    mimeType: blob.type || "video/webm",
    createdAtMs: now,
    updatedAtMs: now,
    startedAtMs,
    stoppedAtMs: endedAtMs,
    status: "complete",
    chunkCount: 1,
    sizeBytes: blob.size,
  };
  const chunk: StoredMediaChunk = {
    key: `${recordingId}:00000000`,
    recordingId,
    sequence: 0,
    startAtMs: startedAtMs,
    endAtMs: endedAtMs,
    mimeType: recording.mimeType,
    sizeBytes: blob.size,
    blob,
    uploadState: "pending",
    uploadAttempts: 0,
  };
  await store.putRecording(recording);
  await store.putChunk(chunk);
}

export class FrameRingBurstRecorder {
  private readonly participantId: string;
  private readonly frameRate: number;
  private readonly maxLongEdge: number;
  private readonly jpegQuality: number;
  private readonly store: MediaChunkStore;
  private readonly now: () => number;
  private readonly onError?: (error: Error) => void;
  private readonly video = document.createElement("video");
  private readonly captureCanvas = document.createElement("canvas");
  private readonly frames: FrameRingEntry[] = [];
  private captureTimer: number | null = null;
  private videoFrameCallbackHandle: number | null = null;
  private lastFrameCallbackAtMs = 0;
  private captureInFlight: Promise<void> | null = null;
  private lifecycle: "idle" | "running" | "stopped" = "idle";
  private firstFrameAtMs: number | null = null;

  constructor(
    private readonly stream: MediaStream,
    options: FrameRingBurstRecorderOptions,
  ) {
    this.participantId = options.participantId;
    this.frameRate = options.frameRate ?? 12;
    this.maxLongEdge = options.maxLongEdge ?? 720;
    this.jpegQuality = options.jpegQuality ?? 0.72;
    this.store = options.store ?? mediaChunkStore;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  get readyAtMs(): number | null {
    return this.firstFrameAtMs === null ? null : this.firstFrameAtMs + BURST_PRE_ROLL_MS;
  }

  async start(): Promise<void> {
    if (this.lifecycle !== "idle") throw new Error(`Local Burst recorder is ${this.lifecycle}.`);
    const videoTrack = this.stream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== "live") throw new Error("A live camera track is required for local Burst capture.");
    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "");
    this.video.srcObject = new MediaStream([videoTrack]);
    await this.video.play();
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => finish(new Error("Camera frames did not become available for local Burst capture.")), 5_000);
        const finish = (error?: Error) => {
          window.clearTimeout(timer);
          this.video.removeEventListener("loadeddata", onReady);
          this.video.removeEventListener("error", onError);
          if (error) reject(error); else resolve();
        };
        const onReady = () => finish();
        const onError = () => finish(new Error(this.video.error?.message || "Camera frame decoding failed."));
        this.video.addEventListener("loadeddata", onReady, { once: true });
        this.video.addEventListener("error", onError, { once: true });
      });
    }
    const settings = videoTrack.getSettings();
    const size = canvasSize(
      this.video.videoWidth || settings.width || 1280,
      this.video.videoHeight || settings.height || 960,
      this.maxLongEdge,
    );
    this.captureCanvas.width = size.width;
    this.captureCanvas.height = size.height;
    this.lifecycle = "running";
    await this.captureFrame();
    this.startFramePump();
  }

  async captureAt(anchorMs: number): Promise<RollingBurstCapture> {
    if (this.lifecycle !== "running") throw new Error("The local Burst recorder is not running.");
    const readyAt = this.readyAtMs;
    if (readyAt === null || anchorMs < readyAt) throw new Error("The exact three-second local pre-roll is still charging.");
    const windowEndMs = anchorMs + BURST_POST_ROLL_MS;
    await wait(windowEndMs - this.now());
    for (let attempt = 0; attempt < 8 && (this.frames.at(-1)?.capturedAtMs ?? 0) < windowEndMs; attempt += 1) {
      await this.captureFrame();
      if ((this.frames.at(-1)?.capturedAtMs ?? 0) < windowEndMs) await wait(80);
    }
    const samples = sampleFrameRingWindow(
      this.frames,
      anchorMs,
      BURST_PRE_ROLL_MS,
      BURST_POST_ROLL_MS,
      this.frameRate,
    );
    if (!samples) throw new Error("The phone could not retain a continuous local T−3 to T+3 frame window.");
    const blob = await this.encodeStandalone(samples);
    if (!blob.size) throw new Error("The standalone local Burst contained no video data.");
    const recordingId = `local-burst-${safeIdentifier(this.participantId)}-${Math.round(anchorMs)}-${crypto.randomUUID()}`;
    const segmentStartedAtMs = anchorMs - BURST_PRE_ROLL_MS;
    const segmentEndedAtMs = anchorMs + BURST_POST_ROLL_MS;
    await persistStandaloneBurst(
      this.store,
      recordingId,
      this.participantId,
      blob,
      segmentStartedAtMs,
      segmentEndedAtMs,
    );
    return {
      recordingId,
      blob,
      mimeType: blob.type || "video/webm",
      anchorMs,
      segmentStartedAtMs,
      segmentEndedAtMs,
      burstOffsetMs: BURST_PRE_ROLL_MS,
      windowStartOffsetMs: 0,
      windowEndOffsetMs: BURST_PRE_ROLL_MS + BURST_POST_ROLL_MS,
      availableDurationMs: BURST_PRE_ROLL_MS + BURST_POST_ROLL_MS,
    };
  }

  async stop(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    this.lifecycle = "stopped";
    if (this.captureTimer !== null) window.clearInterval(this.captureTimer);
    this.captureTimer = null;
    const video = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
    if (this.videoFrameCallbackHandle !== null) video.cancelVideoFrameCallback?.(this.videoFrameCallbackHandle);
    this.videoFrameCallbackHandle = null;
    await this.captureInFlight?.catch(() => undefined);
    this.video.pause();
    this.video.srcObject = null;
    this.frames.length = 0;
    this.captureCanvas.width = 2;
    this.captureCanvas.height = 2;
  }

  private captureFrame(): Promise<void> {
    if (this.captureInFlight) return this.captureInFlight;
    this.captureInFlight = this.captureFrameInternal().finally(() => {
      this.captureInFlight = null;
    });
    return this.captureInFlight;
  }

  private startFramePump() {
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number) => void) => number;
    };
    const intervalMs = 1_000 / this.frameRate;
    if (typeof video.requestVideoFrameCallback === "function") {
      const pump = (now: number) => {
        if (this.lifecycle !== "running") return;
        if (now - this.lastFrameCallbackAtMs >= intervalMs) {
          this.lastFrameCallbackAtMs = now;
          void this.captureFrame().catch((error: unknown) =>
            this.onError?.(error instanceof Error ? error : new Error(String(error))),
          );
        }
        this.videoFrameCallbackHandle = video.requestVideoFrameCallback!(pump);
      };
      this.videoFrameCallbackHandle = video.requestVideoFrameCallback(pump);
      return;
    }
    this.captureTimer = window.setInterval(() => {
      void this.captureFrame().catch((error: unknown) => this.onError?.(error instanceof Error ? error : new Error(String(error))));
    }, Math.round(intervalMs));
  }

  private async captureFrameInternal(): Promise<void> {
    if (this.lifecycle !== "running" || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const context = this.captureCanvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Local Burst frame capture is unavailable.");
    context.drawImage(this.video, 0, 0, this.captureCanvas.width, this.captureCanvas.height);
    const blob = await canvasBlob(this.captureCanvas, this.jpegQuality);
    const capturedAtMs = this.now();
    this.firstFrameAtMs ??= capturedAtMs;
    this.frames.push({ capturedAtMs, blob });
    const cutoff = frameRingRetentionCutoff(capturedAtMs);
    while (this.frames.length > 1 && this.frames[1].capturedAtMs < cutoff) this.frames.shift();
  }

  private async encodeStandalone(samples: FrameRingEntry[]): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = this.captureCanvas.width;
    canvas.height = this.captureCanvas.height;
    const context = canvas.getContext("2d", { alpha: false });
    const captureStream = (canvas as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream }).captureStream;
    if (!context || typeof captureStream !== "function") {
      throw new Error("This browser cannot encode a standalone local Burst from retained frames.");
    }
    await drawBlobFrame(context, samples[0].blob, canvas.width, canvas.height);
    const output = captureStream.call(canvas, this.frameRate);
    const videoTrack = output.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const selection = negotiateRecorderCodec();
    const recorder = new MediaRecorder(output, mediaRecorderOptions(selection, 520_000, 0));
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener("error", (event) => reject(new Error(`Local Burst encoding failed: ${event.type}`)), { once: true });
    });
    recorder.start();
    const frameDelayMs = 1_000 / this.frameRate;
    try {
      for (const sample of samples) {
        await drawBlobFrame(context, sample.blob, canvas.width, canvas.height);
        videoTrack.requestFrame?.();
        await wait(frameDelayMs);
      }
      recorder.stop();
      await stopped;
      return new Blob(chunks, { type: recorder.mimeType || selection.mimeType || "video/webm" });
    } finally {
      if (recorder.state !== "inactive") recorder.stop();
      output.getTracks().forEach((track) => track.stop());
      canvas.width = 2;
      canvas.height = 2;
    }
  }
}
