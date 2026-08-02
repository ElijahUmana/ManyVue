import { v } from "convex/values";

export const sessionStatus = v.union(
  v.literal("lobby"),
  v.literal("live"),
  v.literal("ended"),
);

export const participantRole = v.union(
  v.literal("attendee"),
  v.literal("presenter"),
  v.literal("seed_camera"),
);

export const connectionState = v.union(
  v.literal("online"),
  v.literal("degraded"),
  v.literal("offline"),
);

export const recordingState = v.union(
  v.literal("idle"),
  v.literal("recording"),
  v.literal("uploading"),
  v.literal("ready"),
  v.literal("error"),
);

export const sceneLayout = v.union(v.literal("hero"), v.literal("duo"), v.literal("sweep"));

export const sceneSource = v.union(
  v.literal("manual"),
  v.literal("deterministic"),
  v.literal("ai"),
);

export const sceneStatus = v.union(
  v.literal("scheduled"),
  v.literal("superseded"),
  v.literal("completed"),
);

export const burstStatus = v.union(
  v.literal("collecting"),
  v.literal("preview_ready"),
  v.literal("rendering"),
  v.literal("complete"),
  v.literal("failed"),
);

export const contributionStatus = v.union(
  v.literal("requested"),
  v.literal("preserved"),
  v.literal("uploading"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("unavailable"),
);

export const assetKind = v.union(
  v.literal("original_clip"),
  v.literal("burst_clip"),
  v.literal("burst_frame"),
  v.literal("program_recording"),
  v.literal("master_audio"),
  v.literal("render_output"),
  v.literal("thumbnail"),
);

export const assetStatus = v.union(
  v.literal("pending"),
  v.literal("uploading"),
  v.literal("ready"),
  v.literal("failed"),
);

export const renderStatus = v.union(
  v.literal("queued"),
  v.literal("assembling"),
  v.literal("submitted"),
  v.literal("rendering"),
  v.literal("succeeded"),
  v.literal("retryable"),
  v.literal("failed"),
);

export const mediaHealth = v.object({
  blocked: v.boolean(),
  frozen: v.boolean(),
  dark: v.boolean(),
  blurScore: v.optional(v.number()),
  motionScore: v.optional(v.number()),
  connectionQuality: v.optional(v.number()),
  observedAt: v.number(),
});

export const deviceInfo = v.object({
  userAgent: v.optional(v.string()),
  platform: v.optional(v.string()),
  orientation: v.optional(v.union(v.literal("portrait"), v.literal("landscape"))),
  mimeType: v.optional(v.string()),
});

