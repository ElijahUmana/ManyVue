import { MediaChunkStore, mediaChunkStore } from "./chunk-store";
import { DurableMediaRecorder } from "./durable-recorder";
import { selectDurableBurstChunks } from "./durable-burst-window";
import { BURST_POST_ROLL_MS, BURST_PRE_ROLL_MS } from "./rolling-burst-recorder";
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
    const preRollMs = input.preRollMs ?? BURST_PRE_ROLL_MS;
    const postRollMs = input.postRollMs ?? BURST_POST_ROLL_MS;
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

    const selected = selectDurableBurstChunks(
      await this.store.listChunks(this.recorder.recordingId),
      (await this.store.getRecording(this.recorder.recordingId))?.startedAtMs ?? localMomentMs - preRollMs,
      localMomentMs,
      preRollMs,
      postRollMs,
    );
    if (!selected) {
      throw new Error("No complete local recording covers this ManyVue Burst window.");
    }

    return {
      marker,
      chunks: selected.chunks,
      blob: new Blob(
        selected.chunks.map((chunk) => chunk.blob),
        { type: this.recorder.mimeType },
      ),
      actualStartAtMs: selected.coverageStartedAtMs,
      actualEndAtMs: selected.coverageEndedAtMs,
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
