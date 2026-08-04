import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { assertHost, assertParticipant, publicParticipant, publicSession } from "./lib/capabilities";
import {
  assertParticipantsBelongToSession,
  connectedParticipantsBySessionSince,
  participantCanReceiveScheduledControl,
  participantIsLiveCamera,
  recentParticipantsBySession,
  requireSessionBySlug,
} from "./lib/runtime";
import { sceneLayout, sceneSource } from "./validators";
import { normalizeSceneCutAt, validateSceneRecipe } from "../lib/realtime/scenes";
import { planAutomaticScene } from "../lib/realtime/autodirector";
import {
  CONTROL_RECOVERY_GRACE_MS,
  PRESENCE_STALE_AFTER_MS,
} from "../lib/realtime/constants";

// Retain the legacy result type while returning no Burst payload at runtime so
// existing clients can roll over to bursts.activeCaptureAnchor without a
// flag-day generated-type break. Burst capture and director state are separate
// realtime domains.
type LegacyProgramBurst = {
  _id: Id<"bursts">;
  anchorServerMs: number;
  windowStartServerMs: number;
  windowEndServerMs: number;
  initiatorParticipantIds: Id<"participants">[];
  expectedParticipantIds: Id<"participants">[];
  readyContributionCount: number;
  uploadedReadyContributionCount: number;
  acknowledgedContributionCount: number;
  status: Doc<"bursts">["status"];
};

async function commitScene(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  args: {
    layout: "hero" | "duo" | "sweep";
    activeParticipantIds: Id<"participants">[];
    cutAtServerMs: number;
    source: "manual" | "deterministic" | "ai";
    reason?: string;
    idempotencyKey: string;
  },
) {
  const existing = await ctx.db
    .query("scenes")
    .withIndex("by_session_idempotency", (q) =>
      q.eq("sessionId", session._id).eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) return existing;
  const now = Date.now();
  const cutAtServerMs = normalizeSceneCutAt(args.cutAtServerMs, now);
  const validationError = validateSceneRecipe({
    layout: args.layout,
    activeParticipantIds: args.activeParticipantIds.map(String),
    cutAtServerMs,
    nowMs: now,
  });
  if (validationError) throw new ConvexError({ code: "INVALID_SCENE", message: validationError });
  const participants = await assertParticipantsBelongToSession(ctx, session._id, args.activeParticipantIds);
  if (participants.some((participant) => !participantCanReceiveScheduledControl(participant!, now))) {
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
    cutAtServerMs,
    source: args.source,
    reason: args.reason?.trim().slice(0, 240),
    idempotencyKey: args.idempotencyKey,
    status: "scheduled",
    createdAt: now,
  });
  if (session.currentSceneId) {
    const prior = await ctx.db.get(session.currentSceneId);
    if (prior) await ctx.db.patch(prior._id, { status: prior.cutAtServerMs <= now ? "completed" : "superseded" });
  }
  await ctx.db.patch(session._id, { currentSceneId: sceneId, sceneRevision: revision });
  return await ctx.db.get(sceneId);
}

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
    return await commitScene(ctx, session, args);
  },
});

export const scheduleAutoScene = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    cutAtServerMs: v.number(),
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
    const connected = await connectedParticipantsBySessionSince(
      ctx,
      session._id,
      now - PRESENCE_STALE_AFTER_MS,
    );
    const strictLive = connected.filter((participant) => participantIsLiveCamera(participant, now));
    // AUTO normally uses strict heartbeat state. If every visible recording
    // camera was just expired by timer throttling, make one bounded recovery
    // attempt instead of leaving the AUTO button apparently inert.
    const live = strictLive.length
      ? strictLive
      : (await recentParticipantsBySession(
          ctx,
          session._id,
          now - CONTROL_RECOVERY_GRACE_MS,
        )).filter((participant) => participantCanReceiveScheduledControl(participant, now));
    const previous = session.currentSceneId ? await ctx.db.get(session.currentSceneId) : null;
    const plan = planAutomaticScene({
      cameras: live.map((camera) => ({
        id: String(camera._id),
        joinedAt: camera.joinedAt,
        quality: camera.mediaHealth?.connectionQuality ?? 0.75,
        stageZone: camera.shotMetadata?.stageZone ?? "unknown",
        framing: camera.shotMetadata?.framing ?? "unknown",
        metadataConfidence: camera.shotMetadata?.confidence ?? 0,
      })),
      previousCameraIds: previous?.activeParticipantIds.map(String) ?? [],
      nextRevision: session.sceneRevision + 1,
    });
    if (!plan) throw new ConvexError({ code: "NO_LIVE_CAMERAS", message: "No healthy recording camera is available." });
    return await commitScene(ctx, session, {
      layout: plan.layout,
      activeParticipantIds: plan.activeCameraIds as Id<"participants">[],
      cutAtServerMs: args.cutAtServerMs,
      source: "deterministic",
      reason: plan.reason,
      idempotencyKey: args.idempotencyKey,
    });
  },
});

export const programState = query({
  args: { sessionSlug: v.string() },
  handler: async (ctx, { sessionSlug }) => {
    const session = await requireSessionBySlug(ctx, sessionSlug);
    const now = Date.now();
    const participants = await connectedParticipantsBySessionSince(
      ctx,
      session._id,
      now - PRESENCE_STALE_AFTER_MS,
    );
    const scene = session.currentSceneId ? await ctx.db.get(session.currentSceneId) : null;
    return {
      serverNowMs: now,
      session: publicSession(session),
      scene,
      liveCameras: participants.filter((participant) => participantIsLiveCamera(participant, now)).map(publicParticipant),
      // Deprecated compatibility field. Program View never receives capture
      // anchors, so a participant Burst cannot alter its visual/status state.
      latestBurst: null as LegacyProgramBurst | null,
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
