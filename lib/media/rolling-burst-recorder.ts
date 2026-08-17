import { MediaChunkStore, mediaChunkStore } from "./chunk-store";
import { DurableMediaRecorder } from "./durable-recorder";

export const BURST_PRE_ROLL_MS = 3_000;
export const BURST_POST_ROLL_MS = 3_000;
export const ROLLING_SEGMENT_DURATION_MS = 10_000;
export const ROLLING_SEGMENT_INTERVAL_MS = 3_000;
export const ROLLING_BURST_VIDEO_BITS_PER_SECOND = 560_000;
export const ROLLING_BURST_AUDIO_BITS_PER_SECOND = 48_000;
export const ROLLING_BURST_MAX_BYTES = 950_000;

export interface BurstSegmentCoverage {
  id: string;
  startedAtMs: number;
  coverageEndAtMs: number;
}

export interface BurstWindow {
  anchorMs: number;
  startsAtMs: number;
  endsAtMs: number;
}

export function burstWindow(
  anchorMs: number,
  preRollMs = BURST_PRE_ROLL_MS,
  postRollMs = BURST_POST_ROLL_MS,
): BurstWindow {
  if (![anchorMs, preRollMs, postRollMs].every(Number.isFinite) || preRollMs < 0 || postRollMs < 0) {
    throw new Error("Burst timing values must be finite and non-negative.");
  }
  return { anchorMs, startsAtMs: anchorMs - preRollMs, endsAtMs: anchorMs + postRollMs };
}

export function segmentCoversBurstWindow(
  segment: BurstSegmentCoverage,
  anchorMs: number,
  preRollMs = BURST_PRE_ROLL_MS,
  postRollMs = BURST_POST_ROLL_MS,
): boolean {
  const window = burstWindow(anchorMs, preRollMs, postRollMs);
  return segment.startedAtMs <= window.startsAtMs && segment.coverageEndAtMs >= window.endsAtMs;
}

/** Selects the latest complete-file segment that covers the exact window,
 * minimizing surplus pre-roll while never synthesizing missing time. */
export function selectCoveringBurstSegment<T extends BurstSegmentCoverage>(
  segments: readonly T[],
  anchorMs: number,
  preRollMs = BURST_PRE_ROLL_MS,
  postRollMs = BURST_POST_ROLL_MS,
): T | null {
  return segments
    .filter((segment) => segmentCoversBurstWindow(segment, anchorMs, preRollMs, postRollMs))
    .sort((left, right) => right.startedAtMs - left.startedAtMs)[0] ?? null;
}

export interface RollingBurstCapture {
  recordingId: string;
  blob: Blob;
  mimeType: string;
  anchorMs: number;
  segmentStartedAtMs: number;
  segmentEndedAtMs: number;
  burstOffsetMs: number;
  windowStartOffsetMs: number;
  windowEndOffsetMs: number;
  availableDurationMs: number;
}

export interface RollingBurstRecorderOptions {
  participantId: string;
  preRollMs?: number;
  postRollMs?: number;
  segmentDurationMs?: number;
  segmentIntervalMs?: number;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  maxSegmentBytes?: number;
  maxStoredSegments?: number;
  storageRetentionMs?: number;
  store?: MediaChunkStore;
  now?: () => number;
  onError?: (error: RollingBurstRecorderError) => void;
}

export type RollingBurstRecorderErrorCode =
  | "INVALID_CONFIGURATION"
  | "NOT_RUNNING"
  | "WARMING_UP"
  | "COVERAGE_GAP"
  | "SEGMENT_FAILED"
  | "SEGMENT_OVERSIZE"
  | "STORAGE_MAINTENANCE_FAILED";

export class RollingBurstRecorderError extends Error {
  constructor(
    readonly code: RollingBurstRecorderErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RollingBurstRecorderError";
  }
}

interface CompletedSegment extends BurstSegmentCoverage {
  endedAtMs: number;
  result: Awaited<ReturnType<DurableMediaRecorder["stop"]>>;
}

interface RuntimeSegment extends BurstSegmentCoverage {
  recorder: DurableMediaRecorder;
  stopTimer: ReturnType<typeof setTimeout>;
  state: "recording" | "finalizing" | "complete" | "failed";
  completed?: CompletedSegment;
  failure?: RollingBurstRecorderError;
  finalizePromise?: Promise<CompletedSegment>;
  pins: number;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 72) || "camera";
}

function configurationError(message: string): never {
  throw new RollingBurstRecorderError("INVALID_CONFIGURATION", message);
}

export class RollingBurstRecorder {
  private readonly participantId: string;
  private readonly preRollMs: number;
  private readonly postRollMs: number;
  private readonly segmentDurationMs: number;
  private readonly segmentIntervalMs: number;
  private readonly videoBitsPerSecond: number;
  private readonly audioBitsPerSecond: number;
  private readonly maxSegmentBytes: number;
  private readonly maxStoredSegments: number;
  private readonly storageRetentionMs: number;
  private readonly store: MediaChunkStore;
  private readonly now: () => number;
  private readonly onError?: (error: RollingBurstRecorderError) => void;
  private readonly recordingPrefix: string;
  private readonly segments: RuntimeSegment[] = [];
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private opening: Promise<void> = Promise.resolve();
  private lifecycle: "idle" | "running" | "stopping" | "stopped" = "idle";
  private firstSegmentStartedAtMs: number | null = null;
  private lastReportedError: RollingBurstRecorderError | null = null;

  constructor(
    private readonly stream: MediaStream,
    options: RollingBurstRecorderOptions,
  ) {
    this.participantId = options.participantId;
    this.preRollMs = options.preRollMs ?? BURST_PRE_ROLL_MS;
    this.postRollMs = options.postRollMs ?? BURST_POST_ROLL_MS;
    this.segmentDurationMs = options.segmentDurationMs ?? ROLLING_SEGMENT_DURATION_MS;
    this.segmentIntervalMs = options.segmentIntervalMs ?? ROLLING_SEGMENT_INTERVAL_MS;
    this.videoBitsPerSecond = options.videoBitsPerSecond ?? ROLLING_BURST_VIDEO_BITS_PER_SECOND;
    this.audioBitsPerSecond = options.audioBitsPerSecond ?? ROLLING_BURST_AUDIO_BITS_PER_SECOND;
    this.maxSegmentBytes = options.maxSegmentBytes ?? ROLLING_BURST_MAX_BYTES;
    this.maxStoredSegments = options.maxStoredSegments ?? 8;
    this.storageRetentionMs = options.storageRetentionMs ?? 60_000;
    this.store = options.store ?? mediaChunkStore;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    this.recordingPrefix = `rolling-burst-${safeIdentifier(this.participantId)}-`;

    if (!this.participantId.trim()) configurationError("A participant ID is required.");
    if (!this.stream.getVideoTracks().some((track) => track.readyState === "live")) {
      configurationError("A live video track is required.");
    }
    if (this.preRollMs !== BURST_PRE_ROLL_MS || this.postRollMs !== BURST_POST_ROLL_MS) {
      configurationError("ManyVue Burst capture must preserve exactly three seconds before and after the anchor.");
    }
    if (this.segmentIntervalMs <= 0 || this.segmentDurationMs < this.preRollMs + this.postRollMs + this.segmentIntervalMs) {
      configurationError("Rolling segments must overlap enough to cover every six-second Burst window.");
    }
    if (
      !Number.isFinite(this.videoBitsPerSecond) ||
      !Number.isFinite(this.audioBitsPerSecond) ||
      this.videoBitsPerSecond <= 0 ||
      this.audioBitsPerSecond < 0
    ) {
      configurationError("Rolling recorder bitrates must be finite and non-negative.");
    }
    const expectedBytes = ((this.videoBitsPerSecond + this.audioBitsPerSecond) * this.segmentDurationMs) / 8_000;
    if (expectedBytes * 1.2 > this.maxSegmentBytes) {
      configurationError("Configured rolling segment bitrate has insufficient upload-size headroom.");
    }
    if (!Number.isSafeInteger(this.maxStoredSegments) || this.maxStoredSegments < 2) {
      configurationError("At least two stored rolling segments are required.");
    }
  }

  get state(): "idle" | "running" | "stopping" | "stopped" {
    return this.lifecycle;
  }

  get readyAtMs(): number | null {
    return this.firstSegmentStartedAtMs === null
      ? null
      : this.firstSegmentStartedAtMs + this.preRollMs;
  }

  get lastError(): RollingBurstRecorderError | null {
    return this.lastReportedError;
  }

  async start(): Promise<void> {
    if (this.lifecycle !== "idle") {
      throw new RollingBurstRecorderError("NOT_RUNNING", `Cannot start a rolling recorder in ${this.lifecycle} state.`);
    }
    await this.pruneStoredSegments();
    this.lifecycle = "running";
    try {
      await this.openSegment();
    } catch (error) {
      this.lifecycle = "stopped";
      throw error;
    }
    this.rotationTimer = setInterval(() => {
      this.opening = this.opening
        .then(() => this.openSegment())
        .catch((error: unknown) => this.report("SEGMENT_FAILED", "A rolling segment could not start.", error));
    }, this.segmentIntervalMs);
  }

  async captureAt(anchorMs: number): Promise<RollingBurstCapture> {
    if (this.lifecycle !== "running") {
      throw new RollingBurstRecorderError("NOT_RUNNING", "Start the rolling Burst recorder before capturing a moment.");
    }
    if (!Number.isFinite(anchorMs)) {
      throw new RollingBurstRecorderError("COVERAGE_GAP", "Burst anchor must be a finite local timestamp.");
    }
    await this.opening;
    const candidate = selectCoveringBurstSegment(this.segments, anchorMs, this.preRollMs, this.postRollMs);
    if (!candidate) {
      const readyAt = this.readyAtMs;
      if (readyAt !== null && anchorMs < readyAt) {
        throw new RollingBurstRecorderError(
          "WARMING_UP",
          `The rolling camera needs ${Math.max(0, Math.ceil(readyAt - anchorMs))}ms more pre-roll before an exact Burst is possible.`,
        );
      }
      throw new RollingBurstRecorderError(
        "COVERAGE_GAP",
        "No complete rolling segment covers the exact three seconds before and after this Burst.",
      );
    }

    candidate.pins += 1;
    try {
      const exactWindowEndMs = anchorMs + this.postRollMs;
      const remainingPostRollMs = exactWindowEndMs - this.now();
      if (remainingPostRollMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingPostRollMs));
      }
      // Finalize at the earliest truthful instant: as soon as T+3 exists. A
      // later scheduled segment stop only adds latency and surplus footage.
      const completed = await this.finalizeSegment(candidate);
      if (!segmentCoversBurstWindow(
        { ...completed, coverageEndAtMs: completed.endedAtMs },
        anchorMs,
        this.preRollMs,
        this.postRollMs,
      )) {
        throw new RollingBurstRecorderError(
          "COVERAGE_GAP",
          "The completed rolling segment ended before the full Burst post-roll was preserved.",
        );
      }
      if (!completed.result.blob.size) {
        throw new RollingBurstRecorderError("SEGMENT_FAILED", "The completed Burst segment contains no media bytes.");
      }
      if (completed.result.blob.size > this.maxSegmentBytes) {
        throw new RollingBurstRecorderError(
          "SEGMENT_OVERSIZE",
          `The complete Burst segment is ${completed.result.blob.size} bytes, above the ${this.maxSegmentBytes}-byte upload ceiling.`,
        );
      }
      const burstOffsetMs = anchorMs - completed.startedAtMs;
      return {
        recordingId: completed.id,
        blob: completed.result.blob,
        mimeType: completed.result.recording.mimeType,
        anchorMs,
        segmentStartedAtMs: completed.startedAtMs,
        segmentEndedAtMs: completed.endedAtMs,
        burstOffsetMs,
        windowStartOffsetMs: burstOffsetMs - this.preRollMs,
        windowEndOffsetMs: burstOffsetMs + this.postRollMs,
        availableDurationMs: completed.endedAtMs - completed.startedAtMs,
      };
    } finally {
      candidate.pins -= 1;
      this.pruneMemory();
      void this.pruneStoredSegments().catch((error: unknown) => {
        this.report("STORAGE_MAINTENANCE_FAILED", "Could not prune stale rolling Burst recordings.", error);
      });
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === "idle" || this.lifecycle === "stopped") {
      this.lifecycle = "stopped";
      return;
    }
    this.lifecycle = "stopping";
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rotationTimer = null;
    await this.opening;
    await Promise.all(this.segments
      .filter((segment) => segment.state === "recording" || segment.state === "finalizing")
      .map((segment) => this.finalizeSegment(segment)));
    this.lifecycle = "stopped";
    await this.pruneStoredSegments();
  }

  private async openSegment(): Promise<void> {
    if (this.lifecycle !== "running") return;
    const recordingId = `${this.recordingPrefix}${this.now()}-${crypto.randomUUID()}`;
    const recorder = new DurableMediaRecorder(this.stream, {
      recordingId,
      participantId: this.participantId,
      chunkDurationMs: 1_000,
      videoBitsPerSecond: this.videoBitsPerSecond,
      audioBitsPerSecond: this.audioBitsPerSecond,
      store: this.store,
    });
    await recorder.start();
    const startedAtMs = this.now();
    const segment = {} as RuntimeSegment;
    Object.assign(segment, {
      id: recordingId,
      recorder,
      startedAtMs,
      coverageEndAtMs: startedAtMs + this.segmentDurationMs,
      state: "recording",
      pins: 0,
      stopTimer: setTimeout(() => {
        void this.finalizeSegment(segment).catch((error: unknown) => {
          this.report("SEGMENT_FAILED", "A rolling segment could not be finalized.", error);
        });
      }, this.segmentDurationMs),
    } satisfies RuntimeSegment);
    this.segments.push(segment);
    this.firstSegmentStartedAtMs ??= startedAtMs;
    this.pruneMemory();
  }

  private finalizeSegment(segment: RuntimeSegment): Promise<CompletedSegment> {
    if (segment.finalizePromise) return segment.finalizePromise;
    segment.state = "finalizing";
    clearTimeout(segment.stopTimer);
    segment.finalizePromise = segment.recorder.stop()
      .then((result) => {
        const completed: CompletedSegment = {
          id: segment.id,
          startedAtMs: segment.startedAtMs,
          coverageEndAtMs: this.now(),
          endedAtMs: this.now(),
          result,
        };
        segment.completed = completed;
        segment.coverageEndAtMs = completed.endedAtMs;
        segment.state = "complete";
        this.pruneMemory();
        void this.pruneStoredSegments().catch((error: unknown) => {
          this.report("STORAGE_MAINTENANCE_FAILED", "Could not prune stale rolling Burst recordings.", error);
        });
        return completed;
      })
      .catch((error: unknown) => {
        const failure = error instanceof RollingBurstRecorderError
          ? error
          : new RollingBurstRecorderError("SEGMENT_FAILED", "A rolling Burst segment failed to finalize.", error);
        segment.failure = failure;
        segment.state = "failed";
        throw failure;
      });
    // Timer-driven completion may precede a Burst request; mark the rejection
    // observed without changing the promise returned to later capture calls.
    void segment.finalizePromise.catch(() => undefined);
    return segment.finalizePromise;
  }

  private pruneMemory(): void {
    const cutoff = this.now() - this.storageRetentionMs;
    const removable = this.segments
      .filter((segment) => segment.state !== "recording" && segment.state !== "finalizing" && segment.pins === 0)
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
    const removeIds = new Set(removable
      .filter((segment, index) => segment.startedAtMs < cutoff || index >= this.maxStoredSegments)
      .map((segment) => segment.id));
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      if (removeIds.has(this.segments[index].id)) this.segments.splice(index, 1);
    }
  }

  private async pruneStoredSegments(): Promise<void> {
    const activeIds = new Set(this.segments
      .filter((segment) => segment.state === "recording" || segment.state === "finalizing" || segment.pins > 0)
      .map((segment) => segment.id));
    const cutoff = this.now() - this.storageRetentionMs;
    const stored = (await this.store.listRecordings())
      .filter((recording) => recording.id.startsWith(this.recordingPrefix));
    const deletions = stored
      .filter((recording, index) =>
        !activeIds.has(recording.id) &&
        (recording.updatedAtMs < cutoff || index >= this.maxStoredSegments),
      )
      .map((recording) => this.store.deleteRecording(recording.id));
    await Promise.all(deletions);
  }

  private report(
    code: RollingBurstRecorderErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    const error = cause instanceof RollingBurstRecorderError
      ? cause
      : new RollingBurstRecorderError(code, message, cause);
    this.lastReportedError = error;
    this.onError?.(error);
  }
}
