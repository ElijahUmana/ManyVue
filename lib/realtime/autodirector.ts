import type { SceneLayout } from "./scenes";

export type CameraStageZone = "left" | "center" | "right" | "crowd" | "unknown";
export type CameraFraming = "close" | "medium" | "wide" | "unknown";

export type AutoDirectorCamera = {
  id: string;
  joinedAt: number;
  quality: number;
  stageZone: CameraStageZone;
  framing: CameraFraming;
  metadataConfidence: number;
};

export type AutoScenePlan = {
  layout: SceneLayout;
  activeCameraIds: string[];
  reason: string;
};

const zoneOrder: Record<CameraStageZone, number> = {
  left: 0,
  center: 1,
  right: 2,
  crowd: 3,
  unknown: 4,
};

function baseScore(camera: AutoDirectorCamera, previousIds: ReadonlySet<string>): number {
  const quality = Math.max(0, Math.min(1, camera.quality));
  const confidence = Math.max(0, Math.min(1, camera.metadataConfidence));
  const freshness = previousIds.has(camera.id) ? 0 : 0.34;
  const heroValue = camera.framing === "close" ? 0.16 : camera.stageZone === "center" ? 0.11 : 0;
  return quality + confidence * 0.1 + freshness + heroValue;
}

function stableRank(cameras: AutoDirectorCamera[], previousIds: ReadonlySet<string>) {
  return [...cameras].sort((a, b) => {
    const delta = baseScore(b, previousIds) - baseScore(a, previousIds);
    if (Math.abs(delta) > 0.0001) return delta;
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return a.id.localeCompare(b.id);
  });
}

function complementaryScore(primary: AutoDirectorCamera, candidate: AutoDirectorCamera): number {
  let score = candidate.quality;
  if (candidate.stageZone !== primary.stageZone) score += 0.45;
  if (candidate.framing !== primary.framing) score += 0.35;
  if (candidate.stageZone === "crowd") score += 0.18;
  if (candidate.framing === "wide") score += 0.16;
  return score;
}

/** Produces the same scene for the same realtime snapshot—no random cuts. */
export function planAutomaticScene(input: {
  cameras: AutoDirectorCamera[];
  previousCameraIds: readonly string[];
  nextRevision: number;
}): AutoScenePlan | null {
  if (input.cameras.length === 0) return null;
  const previous = new Set(input.previousCameraIds);
  const ranked = stableRank(input.cameras, previous);
  if (ranked.length === 1) {
    return { layout: "hero", activeCameraIds: [ranked[0].id], reason: "Only healthy live angle" };
  }

  const cycle = input.nextRevision % 4;
  if (ranked.length >= 3 && cycle === 0) {
    const sweep = [...ranked]
      .sort((a, b) =>
        zoneOrder[a.stageZone] - zoneOrder[b.stageZone] ||
        b.quality - a.quality ||
        a.id.localeCompare(b.id),
      )
      .slice(0, 6);
    return {
      layout: "sweep",
      activeCameraIds: sweep.map((camera) => camera.id),
      reason: `Stage-relative sweep: ${sweep.map((camera) => camera.stageZone).join(" → ")}`,
    };
  }

  if (cycle === 2 || (ranked.length === 2 && cycle === 0)) {
    const primary = ranked[0];
    const complement = ranked
      .slice(1)
      .sort((a, b) => complementaryScore(primary, b) - complementaryScore(primary, a) || a.id.localeCompare(b.id))[0];
    return {
      layout: "duo",
      activeCameraIds: [primary.id, complement.id],
      reason: `${primary.stageZone}/${primary.framing} paired with ${complement.stageZone}/${complement.framing}`,
    };
  }

  return {
    layout: "hero",
    activeCameraIds: [ranked[0].id],
    reason: `Best fresh ${ranked[0].stageZone}/${ranked[0].framing} angle`,
  };
}

