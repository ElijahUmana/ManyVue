export const PRESENCE_HEARTBEAT_MS = 4_000;
// Mobile browsers routinely defer a 5s timer during camera work. Four missed
// heartbeats is still fast enough to expire a dead camera without ejecting a
// healthy feed during one brief main-thread/network stall.
export const PRESENCE_STALE_AFTER_MS = 20_000;
// A host TAKE is stronger evidence than presence: it came from an actual
// LiveKit feed visible in Program View. Allow a bounded recovery window for
// manual/scheduled control, while unattended AUTO still prefers strict-live.
export const CONTROL_RECOVERY_GRACE_MS = 60_000;
export const BURST_CLUSTER_WINDOW_MS = 1_500;
export const BURST_WINDOW_BEFORE_MS = 3_000;
export const BURST_WINDOW_AFTER_MS = 3_000;
export const BURST_CONTRIBUTION_DEADLINE_MS = 8_000;
export const MIN_SCENE_LEAD_MS = 250;
export const MAX_SCENE_LEAD_MS = 10_000;
export const DEFAULT_SCENE_LEAD_MS = 600;
export const MAX_ACTIVE_CAMERAS = 6;
