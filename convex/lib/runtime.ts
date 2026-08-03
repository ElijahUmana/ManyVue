import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  isRecoverableControlCamera,
  isStrictlyLiveCamera,
  type CameraPresence,
} from "../../lib/realtime/presence";

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
  participant: CameraPresence,
  nowMs: number,
): boolean {
  return isStrictlyLiveCamera(participant, nowMs);
}

export function participantCanReceiveScheduledControl(
  participant: CameraPresence,
  nowMs: number,
): boolean {
  return isRecoverableControlCamera(participant, nowMs);
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
