import assert from "node:assert/strict";
import test from "node:test";
import { planAutomaticScene, type AutoDirectorCamera } from "./autodirector";

const cameras: AutoDirectorCamera[] = [
  { id: "left-close", joinedAt: 1, quality: 0.9, stageZone: "left", framing: "close", metadataConfidence: 1 },
  { id: "center-medium", joinedAt: 2, quality: 0.85, stageZone: "center", framing: "medium", metadataConfidence: 1 },
  { id: "right-wide", joinedAt: 3, quality: 0.88, stageZone: "right", framing: "wide", metadataConfidence: 1 },
  { id: "crowd-wide", joinedAt: 4, quality: 0.82, stageZone: "crowd", framing: "wide", metadataConfidence: 1 },
];

test("auto director is deterministic and rotates away from the previous hero", () => {
  const first = planAutomaticScene({ cameras, previousCameraIds: ["left-close"], nextRevision: 1 });
  const second = planAutomaticScene({ cameras, previousCameraIds: ["left-close"], nextRevision: 1 });
  assert.deepEqual(first, second);
  assert.notEqual(first?.activeCameraIds[0], "left-close");
});

test("duo combines contrasting perspectives", () => {
  const plan = planAutomaticScene({ cameras, previousCameraIds: [], nextRevision: 2 });
  assert.equal(plan?.layout, "duo");
  assert.equal(plan?.activeCameraIds.length, 2);
  assert.notEqual(plan?.activeCameraIds[0], plan?.activeCameraIds[1]);
});

test("sweep follows stage-relative order", () => {
  const plan = planAutomaticScene({ cameras, previousCameraIds: [], nextRevision: 4 });
  assert.deepEqual(plan?.activeCameraIds, ["left-close", "center-medium", "right-wide", "crowd-wide"]);
});
