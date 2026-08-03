import assert from "node:assert/strict";
import test from "node:test";
import { isRecoverableControlCamera, isStrictlyLiveCamera } from "./presence";

const camera = {
  connectionState: "online" as const,
  recordingState: "recording" as const,
  lastSeenAt: 1_000,
};

test("strict presence survives ordinary mobile timer jitter", () => {
  assert.equal(isStrictlyLiveCamera(camera, 20_999), true);
  assert.equal(isStrictlyLiveCamera(camera, 21_001), false);
});

test("host control can recover a visible feed after presence briefly expires", () => {
  assert.equal(
    isRecoverableControlCamera({ ...camera, connectionState: "offline" }, 45_000),
    true,
  );
  assert.equal(
    isRecoverableControlCamera({ ...camera, connectionState: "offline" }, 61_001),
    false,
  );
});

test("neither path selects stopped, departed, or explicitly unusable cameras", () => {
  assert.equal(isRecoverableControlCamera({ ...camera, recordingState: "ready" }, 1_100), false);
  assert.equal(isRecoverableControlCamera({ ...camera, leftAt: 1_050 }, 1_100), false);
  assert.equal(
    isRecoverableControlCamera({ ...camera, mediaHealth: { blocked: true, frozen: false, dark: false } }, 1_100),
    false,
  );
});
