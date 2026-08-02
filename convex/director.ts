import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertHost, assertParticipant, publicParticipant, publicSession } from "./lib/capabilities";
import {
  assertParticipantsBelongToSession,
  participantIsLiveCamera,
  requireSessionBySlug,
} from "./lib/runtime";
import { sceneLayout, sceneSource } from "./validators";
import { validateSceneRecipe } from "../lib/realtime/scenes";

export const scheduleScene = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    layout: sceneLayout,
    activeParticipantIds: v.array(v.id("participants")),
    cutAtServerMs: v.number(),
    source: sceneSource,
    reason: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    if (session.status !== "live") {
      throw new ConvexError({ code: "SESSION_NOT_LIVE", message: "Start the live production before scheduling scenes." });
    }
    const existing = await ctx.db
      .query("scenes")
      .withIndex("by_session_idempotency", (q) =>
        q.eq("sessionId", session._id).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing) return existing;

    const now = Date.now();
    const validationError = validateSceneRecipe({
      layout: args.layout,
      activeParticipantIds: args.activeParticipantIds.map(String),
      cutAtServerMs: args.cutAtServerMs,
      nowMs: now,
    });
    if (validationError) {
      throw new ConvexError({ code: "INVALID_SCENE", message: validationError });
    }
    const participants = await assertParticipantsBelongToSession(
      ctx,
      session._id,
      args.activeParticipantIds,
    );
    if (participants.some((participant) => !participantIsLiveCamera(participant!, now))) {
      throw new ConvexError({
        code: "CAMERA_UNAVAILABLE",
        message: "Every selected camera must be recording, connected, recent, and usable.",
      });
    }
    const revision = session.sceneRevision + 1;
    const sceneId = await ctx.db.insert("scenes", {
      sessionId: session._id,
      revision,
      layout: args.layout,
      activeParticipantIds: args.activeParticipantIds,
      cutAtServerMs: args.cutAtServerMs,
      source: args.source,
      reason: args.reason?.trim().slice(0, 240),
      idempotencyKey: args.idempotencyKey,
      status: "scheduled",
      createdAt: now,
    });
    if (session.currentSceneId) {
      const prior = await ctx.db.get(session.currentSceneId);
      if (prior) {
        await ctx.db.patch(prior._id, {
          status: prior.cutAtServerMs <= now ? "completed" : "superseded",
        });
      }
    }
    await ctx.db.patch(session._id, { currentSceneId: sceneId, sceneRevision: revision });
    return await ctx.db.get(sceneId);
  },
});

export const programState = query({
  args: { sessionSlug: v.string() },
  handler: async (ctx, { sessionSlug }) => {
    const session = await requireSessionBySlug(ctx, sessionSlug);
    const now = Date.now();
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    const scene = session.currentSceneId ? await ctx.db.get(session.currentSceneId) : null;
    const latestBurst = await ctx.db
      .query("bursts")
      .withIndex("by_session_anchor", (q) => q.eq("sessionId", session._id))
      .order("desc")
      .first();
    return {
      serverNowMs: now,
      session: publicSession(session),
      scene,
      liveCameras: participants.filter((participant) => participantIsLiveCamera(participant, now)).map(publicParticipant),
      latestBurst: latestBurst
        ? {
            _id: latestBurst._id,
            anchorServerMs: latestBurst.anchorServerMs,
            windowStartServerMs: latestBurst.windowStartServerMs,
            windowEndServerMs: latestBurst.windowEndServerMs,
            expectedParticipantIds: latestBurst.expectedParticipantIds,
            readyContributionCount: latestBurst.readyContributionCount,
            status: latestBurst.status,
          }
        : null,
    };
  },
});

export const participantScene = query({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const session = await ctx.db.get(participant.sessionId);
    if (!session) return null;
    const scene = session.currentSceneId ? await ctx.db.get(session.currentSceneId) : null;
    return {
      serverNowMs: Date.now(),
      revision: scene?.revision ?? 0,
      cutAtServerMs: scene?.cutAtServerMs,
      layout: scene?.layout,
      activeParticipantIds: scene?.activeParticipantIds ?? [],
      selectedInScheduledScene: scene?.activeParticipantIds.includes(participant._id) ?? false,
    };
  },
});
