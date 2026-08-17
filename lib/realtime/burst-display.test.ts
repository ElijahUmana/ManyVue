import assert from "node:assert/strict";
import test from "node:test";
import { burstDisplayState } from "./burst-display";

test("never fabricates one ready angle while a two-angle Burst is starting", () => {
  assert.deepEqual(burstDisplayState({
    hasBurst: true,
    phase: "capturing",
    readyCount: 0,
    expectedCount: 2,
  }), {
    readyCount: 0,
    expectedCount: 2,
    complete: false,
    collecting: true,
  });
});

test("marks the Burst saved only when every expected angle is ready", () => {
  assert.equal(burstDisplayState({ hasBurst: true, phase: "preview", readyCount: 1, expectedCount: 2 }).complete, false);
  assert.equal(burstDisplayState({ hasBurst: true, phase: "preview", readyCount: 2, expectedCount: 2 }).complete, true);
});
