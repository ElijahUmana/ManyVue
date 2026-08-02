import { MediaChunkStore, mediaChunkStore } from "./chunk-store";
import { DurableMediaRecorder } from "./durable-recorder";
import type { BurstCapture, StoredBurstMarker } from "./types";

export interface BurstMarkerInput {
  id?: string;
  participantId: string;
  serverMomentMs: number;
  localMomentMs?: number;
  preRollMs?: number;
  postRollMs?: number;
  clusterId?: string;
}

export interface ServerClockLike {
  serverToLocal(serverMs: number): number;
  localToServer(localMs: number): number;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, delayMs)));
}

export class RollingBurstBuffer {
  constructor(
    private readonly recorder: DurableMediaRecorder,
    private readonly clock: ServerClockLike,
    private readonly store: MediaChunkStore = mediaChunkStore,
  ) {}

  /**
   * Persists a marker immediately, then waits only for the post-roll portion
   * that has not happened yet. The pre-roll is already durable in IndexedDB.
   */
  async capture(input: BurstMarkerInput): Promise<BurstCapture> {
    const preRollMs = input.preRollMs ?? 2_000;
    const postRollMs = input.postRollMs ?? 3_000;
    const localMomentMs =
      input.localMomentMs ?? this.clock.serverToLocal(input.serverMomentMs);
    const marker: StoredBurstMarker = {
      id: input.id ?? crypto.randomUUID(),
      recordingId: this.recorder.recordingId,
      participantId: input.participantId,
      serverMomentMs: input.serverMomentMs,
      localMomentMs,
      preRollMs,
      postRollMs,
      createdAtMs: Date.now(),
      ...(input.clusterId ? { clusterId: input.clusterId } : {}),
    };

    await this.store.putBurstMarker(marker);
    await wait(localMomentMs + postRollMs - Date.now());
    await this.recorder.flush();

    const chunks = await this.store.listChunksInWindow(
      this.recorder.recordingId,
      localMomentMs - preRollMs,
      localMomentMs + postRollMs,
    );
    if (!chunks.length) {
      throw new Error("No locally recorded media overlaps this Crowd Burst marker.");
    }

    return {
      marker,
      chunks,
      blob: new Blob(
        chunks.map((chunk) => chunk.blob),
        { type: this.recorder.mimeType },
      ),
      actualStartAtMs: chunks[0].startAtMs,
      actualEndAtMs: chunks[chunks.length - 1].endAtMs,
    };
  }

  async markNow(
    participantId: string,
    options: Omit<BurstMarkerInput, "participantId" | "serverMomentMs"> = {},
  ): Promise<BurstCapture> {
    const localMomentMs = Date.now();
    return this.capture({
      ...options,
      participantId,
      localMomentMs,
      serverMomentMs: this.clock.localToServer(localMomentMs),
    });
  }
}
