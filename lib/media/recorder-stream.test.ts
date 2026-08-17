import assert from "node:assert/strict";
import test from "node:test";
import { recorderCanvasSize } from "./recorder-stream";

test("recorder relay preserves portrait and landscape aspect ratios without oversized encodes", () => {
  assert.deepEqual(recorderCanvasSize(1280, 960), { width: 960, height: 720 });
  assert.deepEqual(recorderCanvasSize(1080, 1920), { width: 540, height: 960 });
  assert.deepEqual(recorderCanvasSize(640, 480), { width: 640, height: 480 });
});
