import assert from "node:assert/strict";
import test from "node:test";
import { selectDurableBurstChunks } from "./durable-burst-window";
import type { StoredMediaChunk } from "./types";

function chunk(sequence: number, startAtMs: number, endAtMs: number): StoredMediaChunk {
  return {
    key: String(sequence),
    recordingId: "recording",
    sequence,
    startAtMs,
    endAtMs,
    mimeType: "video/mp4",
    sizeBytes: 10,
    blob: new Blob([String(sequence)], { type: "video/mp4" }),
    uploadState: "pending",
    uploadAttempts: 0,
  };
}

test("long iPhone recordings yield a bounded Burst plus the initialization chunk", () => {
  const chunks = Array.from({ length: 90 }, (_, index) => chunk(index, index * 1_000, (index + 1) * 1_000));
  const selected = selectDurableBurstChunks(chunks, 0, 60_000, 3_000, 3_000);
  assert.ok(selected);
  assert.deepEqual(selected.chunks.map((item) => item.sequence), [0, 56, 57, 58, 59, 60, 61, 62, 63]);
  assert.equal(selected.timelineStartedAtMs, 0);
  assert.equal(selected.coverageStartedAtMs, 56_000);
  assert.equal(selected.coverageEndedAtMs, 64_000);
});

test("a Burst fails loudly when durable chunks do not cover the post-roll", () => {
  const chunks = [chunk(0, 0, 1_000), chunk(1, 1_000, 2_000), chunk(2, 2_000, 3_000)];
  assert.equal(selectDurableBurstChunks(chunks, 0, 2_000, 1_000, 3_000), null);
});
