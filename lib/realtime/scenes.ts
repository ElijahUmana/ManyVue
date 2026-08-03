import {
  MAX_ACTIVE_CAMERAS,
  MAX_SCENE_LEAD_MS,
  MIN_SCENE_LEAD_MS,
  DEFAULT_SCENE_LEAD_MS,
} from "./constants";

export const SCENE_LAYOUTS = ["hero", "duo", "sweep"] as const;
export type SceneLayout = (typeof SCENE_LAYOUTS)[number];

/**
 * A phone may calculate a cut before a slow network hop. Convex is the clock
 * authority, so recover stale/skewed hints into a near-future cut rather than
 * rejecting a valid TAKE that Program View is waiting to display.
 */
export function normalizeSceneCutAt(requestedServerMs: number, nowMs: number): number {
  if (!Number.isFinite(requestedServerMs) || !Number.isFinite(nowMs)) {
    throw new Error("Scene cut timestamps must be finite.");
  }
  const leadMs = requestedServerMs - nowMs;
  if (leadMs < MIN_SCENE_LEAD_MS || leadMs > MAX_SCENE_LEAD_MS) {
    return nowMs + DEFAULT_SCENE_LEAD_MS;
  }
  return requestedServerMs;
}

export function expectedCameraCount(layout: SceneLayout): { min: number; max: number } {
  switch (layout) {
    case "hero":
      return { min: 1, max: 1 };
    case "duo":
      return { min: 2, max: 2 };
    case "sweep":
      return { min: 2, max: MAX_ACTIVE_CAMERAS };
  }
}

export function validateSceneRecipe(input: {
  layout: SceneLayout;
  activeParticipantIds: readonly string[];
  cutAtServerMs: number;
  nowMs: number;
}): string | null {
  const unique = new Set(input.activeParticipantIds);
  if (unique.size !== input.activeParticipantIds.length) {
    return "A scene cannot contain the same camera twice.";
  }
  const expected = expectedCameraCount(input.layout);
  if (unique.size < expected.min || unique.size > expected.max) {
    return `${input.layout} requires ${expected.min}-${expected.max} active cameras.`;
  }
  const leadMs = input.cutAtServerMs - input.nowMs;
  if (leadMs < MIN_SCENE_LEAD_MS || leadMs > MAX_SCENE_LEAD_MS) {
    return `Scene cuts must be scheduled ${MIN_SCENE_LEAD_MS}-${MAX_SCENE_LEAD_MS}ms ahead.`;
  }
  return null;
}
