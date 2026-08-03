import { BURST_CLUSTER_WINDOW_MS } from "./constants";

export type ClusterableBurst = {
  anchorServerMs: number;
  status: "collecting" | "preview_ready" | "rendering" | "complete" | "failed";
};

/**
 * Burst taps near the same musical instant share source contributions, but each
 * marker remains separate so its owner can receive a differently ordered cut.
 */
export function shouldJoinBurstCluster(
  candidate: ClusterableBurst | null,
  markerServerMs: number,
  clusterWindowMs = BURST_CLUSTER_WINDOW_MS,
): boolean {
  if (!candidate || (candidate.status !== "collecting" && candidate.status !== "preview_ready")) return false;
  return Math.abs(candidate.anchorServerMs - markerServerMs) <= clusterWindowMs;
}

export function mergedBurstAnchor(
  currentAnchorMs: number,
  markerServerMs: number,
  markerCountBeforeInsert: number,
): number {
  const count = Math.max(1, markerCountBeforeInsert);
  return Math.round((currentAnchorMs * count + markerServerMs) / (count + 1));
}
