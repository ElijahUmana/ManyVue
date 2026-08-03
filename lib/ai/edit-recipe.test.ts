import assert from "node:assert/strict";
import test from "node:test";
import { buildDeterministicEditRecipe, validateEditRecipe, validateEditRecipeInput } from "./edit-recipe";

test("four-second Burst microclips can be reused in an eight-second truthful cut", () => {
  const validated = validateEditRecipeInput({
    artifactId: "burst-12345678",
    ownerCameraId: "camera-owner",
    durationMs: 8_000,
    candidates: [
      {
        id: "owner-source",
        cameraId: "camera-owner",
        clipUrl: "https://crowdcut.test/owner.mp4",
        contactSheetUrl: "https://crowdcut.test/owner.jpg",
        availableDurationMs: 4_000,
        burstOffsetMs: 1_500,
        qualityScore: 0.9,
      },
      {
        id: "crowd-source",
        cameraId: "camera-crowd",
        clipUrl: "https://crowdcut.test/crowd.mp4",
        availableDurationMs: 4_000,
        burstOffsetMs: 1_500,
        qualityScore: 0.8,
      },
    ],
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const recipe = buildDeterministicEditRecipe(validated.value);
  assert.equal(validateEditRecipe(recipe, validated.value).ok, true);
  assert.equal(recipe.shots.reduce((total, shot) => total + shot.durationMs, 0), 8_000);
  assert.ok(recipe.shots.every((shot) => shot.sourceInMs + shot.durationMs <= 4_000));
});
