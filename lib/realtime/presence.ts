import {
  CONTROL_RECOVERY_GRACE_MS,
  PRESENCE_STALE_AFTER_MS,
} from "./constants";

export type CameraPresence = {
  connectionState: "online" | "degraded" | "offline";
  recordingState: "idle" | "recording" | "uploading" | "ready" | "error";
  lastSeenAt: number;
  leftAt?: number;
  mediaHealth?: { blocked: boolean; frozen: boolean; dark: boolean };
};

function recordingAndUsable(participant: CameraPresence): boolean {
  return (
    participant.recordingState === "recording" &&
    participant.leftAt === undefined &&
    participant.mediaHealth?.blocked !== true &&
    participant.mediaHealth?.frozen !== true &&
    participant.mediaHealth?.dark !== true
  );
}

export function isStrictlyLiveCamera(participant: CameraPresence, nowMs: number): boolean {
  return (
    recordingAndUsable(participant) &&
    participant.connectionState !== "offline" &&
    nowMs - participant.lastSeenAt <= PRESENCE_STALE_AFTER_MS
  );
}

/** Host-scheduled fallback for a feed Program View can still see in LiveKit. */
export function isRecoverableControlCamera(participant: CameraPresence, nowMs: number): boolean {
  return recordingAndUsable(participant) && nowMs - participant.lastSeenAt <= CONTROL_RECOVERY_GRACE_MS;
}

