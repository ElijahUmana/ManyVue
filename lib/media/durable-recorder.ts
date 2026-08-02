import { mediaRecorderOptions, negotiateRecorderCodec } from "./codec";
import { MediaChunkStore, mediaChunkStore } from "./chunk-store";
import type {
  DurableRecordingResult,
  StoredMediaChunk,
  StoredRecording,
} from "./types";

export interface DurableRecorderOptions {
  recordingId: string;
  participantId: string;
  chunkDurationMs?: number;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  store?: MediaChunkStore;
}

export class DurableRecorderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DurableRecorderError";
    this.cause = cause;
  }
}

export class DurableMediaRecorder {
  readonly recordingId: string;
  readonly participantId: string;
  readonly mimeType: string;

  private readonly store: MediaChunkStore;
  private readonly recorder: MediaRecorder;
  private readonly chunkDurationMs: number;
  private metadata: StoredRecording;
  private sequence = 0;
  private previousChunkEndMs: number;
  private pendingWrites: Promise<void> = Promise.resolve();
  private terminalError: DurableRecorderError | null = null;

  constructor(stream: MediaStream, options: DurableRecorderOptions) {
    if (!stream.getVideoTracks().some((track) => track.readyState === "live")) {
      throw new DurableRecorderError("A live camera track is required before recording can start.");
    }

    const selection = negotiateRecorderCodec();
    this.recorder = new MediaRecorder(
      stream,
      mediaRecorderOptions(
        selection,
        options.videoBitsPerSecond,
        options.audioBitsPerSecond,
      ),
    );
    this.recordingId = options.recordingId;
    this.participantId = options.participantId;
    this.mimeType = this.recorder.mimeType || selection.mimeType || "video/webm";
    this.chunkDurationMs = options.chunkDurationMs ?? 1_000;
    this.store = options.store ?? mediaChunkStore;
    const now = Date.now();
    this.previousChunkEndMs = now;
    this.metadata = {
      id: this.recordingId,
      participantId: this.participantId,
      mimeType: this.mimeType,
      createdAtMs: now,
      updatedAtMs: now,
      startedAtMs: now,
      status: "recording",
      chunkCount: 0,
      sizeBytes: 0,
    };

    this.recorder.addEventListener("dataavailable", this.handleDataAvailable);
    this.recorder.addEventListener("error", this.handleRecorderError);
  }

  get state(): RecordingState {
    return this.recorder.state;
  }

  async start(): Promise<void> {
    if (this.recorder.state !== "inactive") {
      throw new DurableRecorderError(`Cannot start a recorder in ${this.recorder.state} state.`);
    }
    await this.store.putRecording(this.metadata);
    this.recorder.start(this.chunkDurationMs);
  }

  async flush(): Promise<void> {
    if (this.recorder.state === "inactive") {
      await this.waitForWrites();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onData = () => {
        cleanup();
        resolve();
      };
      const onError = (event: Event) => {
        cleanup();
        reject(new DurableRecorderError("MediaRecorder failed while flushing a chunk.", event));
      };
      const cleanup = () => {
        this.recorder.removeEventListener("dataavailable", onData);
        this.recorder.removeEventListener("error", onError);
      };
      this.recorder.addEventListener("dataavailable", onData, { once: true });
      this.recorder.addEventListener("error", onError, { once: true });
      this.recorder.requestData();
    });
    await this.waitForWrites();
  }

  async stop(): Promise<DurableRecordingResult> {
    if (this.recorder.state === "inactive") {
      return this.result();
    }

    await new Promise<void>((resolve, reject) => {
      const onStop = () => {
        cleanup();
        resolve();
      };
      const onError = (event: Event) => {
        cleanup();
        reject(new DurableRecorderError("MediaRecorder stopped with an error.", event));
      };
      const cleanup = () => {
        this.recorder.removeEventListener("stop", onStop);
        this.recorder.removeEventListener("error", onError);
      };
      this.recorder.addEventListener("stop", onStop, { once: true });
      this.recorder.addEventListener("error", onError, { once: true });
      this.recorder.stop();
    });

    try {
      await this.waitForWrites();
      this.metadata = {
        ...this.metadata,
        stoppedAtMs: Date.now(),
        updatedAtMs: Date.now(),
        status: "complete",
      };
      await this.store.putRecording(this.metadata);
      return this.result();
    } catch (error) {
      await this.markFailed(error);
      throw error;
    } finally {
      this.removeListeners();
    }
  }

  async result(): Promise<DurableRecordingResult> {
    await this.waitForWrites();
    const recording = (await this.store.getRecording(this.recordingId)) ?? this.metadata;
    const chunks = await this.store.listChunks(this.recordingId);
    return {
      recording,
      chunks,
      blob: new Blob(
        chunks.map((chunk) => chunk.blob),
        { type: recording.mimeType },
      ),
    };
  }

  async waitForWrites(): Promise<void> {
    await this.pendingWrites;
    if (this.terminalError) throw this.terminalError;
  }

  private readonly handleDataAvailable = (event: BlobEvent): void => {
    if (!event.data.size) return;
    const endAtMs = Date.now();
    const sequence = this.sequence++;
    const chunk: StoredMediaChunk = {
      key: `${this.recordingId}:${String(sequence).padStart(8, "0")}`,
      recordingId: this.recordingId,
      sequence,
      startAtMs: this.previousChunkEndMs,
      endAtMs,
      mimeType: event.data.type || this.mimeType,
      sizeBytes: event.data.size,
      blob: event.data,
      uploadState: "pending",
      uploadAttempts: 0,
    };
    this.previousChunkEndMs = endAtMs;

    this.pendingWrites = this.pendingWrites
      .then(async () => {
        await this.store.putChunk(chunk);
        this.metadata = {
          ...this.metadata,
          chunkCount: this.metadata.chunkCount + 1,
          sizeBytes: this.metadata.sizeBytes + chunk.sizeBytes,
          updatedAtMs: Date.now(),
        };
        await this.store.putRecording(this.metadata);
      })
      .catch(async (error: unknown) => {
        this.terminalError = new DurableRecorderError(
          "Local media persistence failed; recording cannot be claimed safe.",
          error,
        );
        await this.markFailed(error);
        throw this.terminalError;
      });
  };

  private readonly handleRecorderError = (event: Event): void => {
    this.terminalError = new DurableRecorderError("The browser media recorder failed.", event);
  };

  private async markFailed(error: unknown): Promise<void> {
    this.metadata = {
      ...this.metadata,
      stoppedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    try {
      await this.store.putRecording(this.metadata);
    } catch (metadataError) {
      // The original persistence failure is the actionable error. This branch
      // intentionally avoids replacing it with a secondary metadata failure.
      console.error("CrowdCut could not persist recorder failure metadata.", metadataError);
    }
  }

  private removeListeners(): void {
    this.recorder.removeEventListener("dataavailable", this.handleDataAvailable);
    this.recorder.removeEventListener("error", this.handleRecorderError);
  }
}
