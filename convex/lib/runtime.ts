import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  isRecoverableControlCamera,
  isStrictlyLiveCamera,
  type CameraPresence,
} from "../../lib/realtime/presence";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

const CONNECTED_STATES = ["online", "degraded"] as const;

export async function requireSessionBySlug(ctx: ReadCtx, slug: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_slug", (q) => q.eq("slug", slug.trim().toLowerCase()))
    .unique();
  if (!session) {
    throw new ConvexError({ code: "SESSION_NOT_FOUND", message: "ManyVue session was not found." });
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

/**
 * Read only participants that can still be live, using the compound index so
 * historical/offline rows never inflate reactive query I/O.
 */
export async function connectedParticipantsBySessionSince(
  ctx: ReadCtx,
  sessionId: Id<"sessions">,
  cutoffMs: number,
): Promise<Doc<"participants">[]> {
  const participants: Doc<"participants">[] = [];
  for (const connectionState of CONNECTED_STATES) {
    const matching = await ctx.db
      .query("participants")
      .withIndex("by_session_connection_state_last_seen", (q) =>
        q
          .eq("sessionId", sessionId)
          .eq("connectionState", connectionState)
          .gte("lastSeenAt", cutoffMs),
      )
      .collect();
    participants.push(...matching);
  }
  return participants;
}

/** A bounded recovery read used only when no strictly-live camera exists. */
export async function recentParticipantsBySession(
  ctx: ReadCtx,
  sessionId: Id<"sessions">,
  cutoffMs: number,
): Promise<Doc<"participants">[]> {
  const participants = await connectedParticipantsBySessionSince(ctx, sessionId, cutoffMs);
  const offline = await ctx.db
    .query("participants")
    .withIndex("by_session_connection_state_last_seen", (q) =>
      q
        .eq("sessionId", sessionId)
        .eq("connectionState", "offline")
        .gte("lastSeenAt", cutoffMs),
    )
    .collect();
  participants.push(...offline);
  return participants;
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
