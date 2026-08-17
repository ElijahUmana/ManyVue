import type { StoredMediaChunk } from "./types";

export type DurableBurstChunkSelection = {
  chunks: StoredMediaChunk[];
  timelineStartedAtMs: number;
  coverageStartedAtMs: number;
  coverageEndedAtMs: number;
};

export type DurableBurstCaptureTiming = {
  segmentStartedAtMs: number;
  segmentEndedAtMs: number;
  burstOffsetMs: number;
  windowStartOffsetMs: number;
  windowEndOffsetMs: number;
  availableDurationMs: number;
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

/**
 * Converts a durable chunk selection into the truthful, bounded capture
 * interval sent to Convex and the media pipeline. The initialization chunk may
 * come from the beginning of a long recording so later fragments remain
 * decodable, but it is not part of the preserved Burst timeline. Reporting the
 * full recording start here would make an otherwise valid six-second Burst
 * look minutes long and fail the server's window validation.
 */
export function durableBurstCaptureTiming(
  selection: DurableBurstChunkSelection,
  anchorMs: number,
  preRollMs: number,
  postRollMs: number,
): DurableBurstCaptureTiming {
  const windowStartMs = anchorMs - preRollMs;
  const windowEndMs = anchorMs + postRollMs;
  if (
    ![anchorMs, preRollMs, postRollMs].every(Number.isFinite) ||
    preRollMs < 0 ||
    postRollMs < 0 ||
    selection.coverageStartedAtMs > windowStartMs ||
    selection.coverageEndedAtMs < windowEndMs
  ) {
    throw new Error("Durable Burst timing does not cover the requested capture window.");
  }

  const segmentStartedAtMs = selection.coverageStartedAtMs;
  const segmentEndedAtMs = selection.coverageEndedAtMs;
  return {
    segmentStartedAtMs,
    segmentEndedAtMs,
    burstOffsetMs: anchorMs - segmentStartedAtMs,
    windowStartOffsetMs: windowStartMs - segmentStartedAtMs,
    windowEndOffsetMs: windowEndMs - segmentStartedAtMs,
    availableDurationMs: segmentEndedAtMs - segmentStartedAtMs,
  };
}
