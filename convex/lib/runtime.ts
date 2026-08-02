import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PRESENCE_STALE_AFTER_MS } from "../../lib/realtime/constants";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export async function requireSessionBySlug(ctx: ReadCtx, slug: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_slug", (q) => q.eq("slug", slug.trim().toLowerCase()))
    .unique();
  if (!session) {
    throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "CrowdCut session was not found." });
  }
  return session;
}

export function participantIsLiveCamera(
  participant: {
    connectionState: "online" | "degraded" | "offline";
    recordingState: "idle" | "recording" | "uploading" | "ready" | "error";
    lastSeenAt: number;
    leftAt?: number;
    mediaHealth?: { blocked: boolean; frozen: boolean; dark: boolean };
  },
  nowMs: number,
): boolean {
  return (
    participant.recordingState === "recording" &&
    participant.connectionState !== "offline" &&
    participant.leftAt === undefined &&
    nowMs - participant.lastSeenAt <= PRESENCE_STALE_AFTER_MS &&
    participant.mediaHealth?.blocked !== true &&
    participant.mediaHealth?.frozen !== true &&
    participant.mediaHealth?.dark !== true
  );
}

export async function assertParticipantsBelongToSession(
  ctx: ReadCtx,
  sessionId: Id<"sessions">,
  participantIds: Id<"participants">[],
) {
  const participants = await Promise.all(participantIds.map((id) => ctx.db.get(id)));
  if (participants.some((participant) => !participant || participant.sessionId !== sessionId)) {
    throw new ConvexError({
      code: "INVALID_SCENE_CAMERA",
      message: "Every scene camera must belong to the active session.",
    });
  }
  return participants;
}

