import assert from "node:assert/strict";
import test from "node:test";
import { mergedBurstAnchor, shouldJoinBurstCluster } from "./burst-clustering";

test("clusters a nearby marker into a collecting burst", () => {
  assert.equal(
    shouldJoinBurstCluster({ anchorServerMs: 10_000, status: "collecting" }, 11_499),
    true,
  );
});

test("does not cluster a distant marker or a closed burst", () => {
  assert.equal(
    shouldJoinBurstCluster({ anchorServerMs: 10_000, status: "collecting" }, 11_501),
    false,
  );
  assert.equal(
    shouldJoinBurstCluster({ anchorServerMs: 10_000, status: "complete" }, 10_100),
    false,
  );
});

test("moves the shared anchor toward later initiators without losing the original cue", () => {
  assert.equal(mergedBurstAnchor(10_000, 10_300, 1), 10_150);
  assert.equal(mergedBurstAnchor(10_150, 10_300, 2), 10_200);
});

