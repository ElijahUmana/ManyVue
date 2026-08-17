import type { StoredMediaChunk } from "./types";

export type DurableBurstChunkSelection = {
  chunks: StoredMediaChunk[];
  timelineStartedAtMs: number;
  coverageStartedAtMs: number;
  coverageEndedAtMs: number;
};

/**
 * MediaRecorder time-slice chunks after the first one can depend on the file's
 * initialization/header chunk. Keep that first chunk plus only the fragments
 * overlapping the Burst window. The encoded upload stays bounded even after a
 * long concert recording, while timestamps remain on the original timeline.
 */
export function selectDurableBurstChunks(
  chunks: readonly StoredMediaChunk[],
  recordingStartedAtMs: number,
  anchorMs: number,
  preRollMs: number,
  postRollMs: number,
): DurableBurstChunkSelection | null {
  const ordered = [...chunks].sort((left, right) => left.sequence - right.sequence);
  if (!ordered.length) return null;
  const windowStart = anchorMs - preRollMs;
  const windowEnd = anchorMs + postRollMs;
  const overlapping = ordered.filter((chunk) =>
    chunk.endAtMs >= windowStart && chunk.startAtMs <= windowEnd,
  );
  if (!overlapping.length) return null;
  const coverageStartedAtMs = overlapping[0].startAtMs;
  const coverageEndedAtMs = overlapping[overlapping.length - 1].endAtMs;
  if (coverageStartedAtMs > windowStart || coverageEndedAtMs < windowEnd) return null;
  const first = ordered[0];
  const selected = first.sequence === overlapping[0].sequence
    ? overlapping
    : [first, ...overlapping];
  return {
    chunks: selected,
    timelineStartedAtMs: recordingStartedAtMs,
    coverageStartedAtMs,
    coverageEndedAtMs,
  };
}
