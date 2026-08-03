import assert from "node:assert/strict";
import test from "node:test";
import {
  BURST_POST_ROLL_MS,
  BURST_PRE_ROLL_MS,
  ROLLING_BURST_AUDIO_BITS_PER_SECOND,
  ROLLING_BURST_MAX_BYTES,
  ROLLING_BURST_VIDEO_BITS_PER_SECOND,
  ROLLING_SEGMENT_DURATION_MS,
  burstWindow,
  segmentCoversBurstWindow,
  selectCoveringBurstSegment,
  type BurstSegmentCoverage,
} from "./rolling-burst-recorder";

function segmentsAt(starts: number[]): BurstSegmentCoverage[] {
  return starts.map((startedAtMs, index) => ({
    id: `segment-${index}`,
    startedAtMs,
    coverageEndAtMs: startedAtMs + ROLLING_SEGMENT_DURATION_MS,
  }));
}

test("Burst window is exactly T-3s through T+3s", () => {
  assert.deepEqual(burstWindow(50_000), {
    anchorMs: 50_000,
    startsAtMs: 47_000,
    endsAtMs: 53_000,
  });
});

test("overlapping complete segments cover every anchor after warmup", () => {
  const segments = segmentsAt(Array.from({ length: 24 }, (_, index) => index * 3_000));
  for (let anchorMs = BURST_PRE_ROLL_MS; anchorMs <= 67_000; anchorMs += 17) {
    const selected = selectCoveringBurstSegment(segments, anchorMs);
    assert.ok(selected, `expected exact coverage at ${anchorMs}ms`);
    assert.ok(selected.startedAtMs <= anchorMs - BURST_PRE_ROLL_MS);
    assert.ok(selected.coverageEndAtMs >= anchorMs + BURST_POST_ROLL_MS);
  }
});

test("one second of segment overlap headroom tolerates delayed rotations", () => {
  const starts = [0, 3_420, 6_710, 10_080, 13_590, 16_940, 20_300];
  const segments = segmentsAt(starts);
  for (let anchorMs = 3_000; anchorMs <= 27_250; anchorMs += 25) {
    assert.ok(selectCoveringBurstSegment(segments, anchorMs), `coverage gap at ${anchorMs}ms`);
  }
});

test("selection chooses the latest full-file segment and rejects partial coverage", () => {
  const complete = segmentsAt([0, 3_000, 6_000]);
  const selected = selectCoveringBurstSegment(complete, 9_000);
  assert.equal(selected?.id, "segment-2");
  assert.equal(segmentCoversBurstWindow({ id: "short", startedAtMs: 6_000, coverageEndAtMs: 11_999 }, 9_000), false);
  assert.equal(selectCoveringBurstSegment(complete, 2_999), null);
});

test("default complete segment has upload-size headroom below the measured ingress ceiling", () => {
  const expectedBytes = (
    (ROLLING_BURST_VIDEO_BITS_PER_SECOND + ROLLING_BURST_AUDIO_BITS_PER_SECOND) *
    ROLLING_SEGMENT_DURATION_MS
  ) / 8_000;
  assert.equal(expectedBytes, 760_000);
  assert.ok(expectedBytes * 1.2 < ROLLING_BURST_MAX_BYTES);
});
