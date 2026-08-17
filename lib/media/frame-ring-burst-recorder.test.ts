import assert from "node:assert/strict";
import test from "node:test";
import { sampleFrameRingWindow } from "./frame-ring-burst-recorder";

test("samples one exact six-second local frame window from a longer recording", () => {
  const frames = Array.from({ length: 121 }, (_, index) => ({
    capturedAtMs: index * 100,
    blob: new Blob([String(index)]),
  }));
  const samples = sampleFrameRingWindow(frames, 8_000, 3_000, 3_000, 10);
  assert.ok(samples);
  assert.equal(samples.length, 61);
  assert.equal(samples[0].capturedAtMs, 5_000);
  assert.equal(samples.at(-1)?.capturedAtMs, 11_000);
});

test("rejects a locally throttled frame ring with a visible coverage gap", () => {
  const frames = [
    { capturedAtMs: 4_900, blob: new Blob(["a"]) },
    { capturedAtMs: 5_000, blob: new Blob(["b"]) },
    { capturedAtMs: 7_000, blob: new Blob(["c"]) },
    { capturedAtMs: 11_000, blob: new Blob(["d"]) },
  ];
  assert.equal(sampleFrameRingWindow(frames, 8_000, 3_000, 3_000, 10), null);
});
