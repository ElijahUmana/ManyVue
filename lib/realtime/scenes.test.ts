import assert from "node:assert/strict";
import test from "node:test";
import { validateSceneRecipe } from "./scenes";

test("accepts a properly scheduled duo", () => {
  assert.equal(
    validateSceneRecipe({
      layout: "duo",
      activeParticipantIds: ["left", "right"],
      nowMs: 1_000,
      cutAtServerMs: 1_500,
    }),
    null,
  );
});

test("rejects duplicate cameras and invalid layout cardinality", () => {
  assert.match(
    validateSceneRecipe({
      layout: "duo",
      activeParticipantIds: ["same", "same"],
      nowMs: 1_000,
      cutAtServerMs: 1_500,
    }) ?? "",
    /same camera/i,
  );
  assert.match(
    validateSceneRecipe({
      layout: "hero",
      activeParticipantIds: ["one", "two"],
      nowMs: 1_000,
      cutAtServerMs: 1_500,
    }) ?? "",
    /requires 1-1/i,
  );
});

test("rejects cuts that clients cannot receive in time", () => {
  assert.match(
    validateSceneRecipe({
      layout: "hero",
      activeParticipantIds: ["one"],
      nowMs: 1_000,
      cutAtServerMs: 1_100,
    }) ?? "",
    /scheduled/i,
  );
});

