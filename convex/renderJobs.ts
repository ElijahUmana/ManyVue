import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { assertParticipant } from "./lib/capabilities";
import { renderStatus } from "./validators";

export const requestForMarker = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    markerId: v.id("burstMarkers"),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const marker = await ctx.db.get(args.markerId);
    if (!marker || marker.participantId !== participant._id) {
      throw new ConvexError({ code: "UNAUTHORIZED_MARKER", message: "Marker does not belong to this camera." });
    }
    const existing = await ctx.db
      .query("renderJobs")
      .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) {
      if (existing.ownerParticipantId !== participant._id) {
        throw new ConvexError({ code: "IDEMPOTENCY_CONFLICT", message: "Render key is already in use." });
      }
      return existing;
    }
    const now = Date.now();
    const renderJobId = await ctx.db.insert("renderJobs", {
      sessionId: participant.sessionId,
      burstId: marker.burstId,
      ownerParticipantId: participant._id,
      requestedByMarkerId: marker._id,
      idempotencyKey: args.idempotencyKey,
      provider: "shotstack",
      status: "queued",
      inputAssetIds: [],
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(renderJobId);
  },
});

export const mine = query({
  args: { participantId: v.id("participants"), participantCapability: v.string() },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    return await ctx.db
      .query("renderJobs")
      .withIndex("by_owner", (q) => q.eq("ownerParticipantId", participant._id))
      .order("desc")
      .collect();
  },
});

export const getInternal = internalQuery({
  args: { renderJobId: v.id("renderJobs") },
  handler: async (ctx, { renderJobId }) => await ctx.db.get(renderJobId),
});

export const setRecipe = internalMutation({
  args: {
    renderJobId: v.id("renderJobs"),
    recipeVersion: v.number(),
    recipeJson: v.string(),
    inputAssetIds: v.array(v.id("assets")),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.renderJobId);
    if (!job) throw new ConvexError({ code: "RENDER_NOT_FOUND", message: "Render job was not found." });
    if (["succeeded", "failed"].includes(job.status)) return job;
    await ctx.db.patch(job._id, {
      status: "assembling",
      recipeVersion: args.recipeVersion,
      recipeJson: args.recipeJson,
      inputAssetIds: args.inputAssetIds,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(job._id);
  },
});

export const markSubmitted = internalMutation({
  args: { renderJobId: v.id("renderJobs"), providerJobId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.renderJobId);
    if (!job) throw new ConvexError({ code: "RENDER_NOT_FOUND", message: "Render job was not found." });
    if (job.providerJobId && job.providerJobId !== args.providerJobId) {
      throw new ConvexError({ code: "PROVIDER_CONFLICT", message: "Render job was already submitted elsewhere." });
    }
    await ctx.db.patch(job._id, {
      providerJobId: args.providerJobId,
      status: "submitted",
      attempt: job.attempt + (job.providerJobId ? 0 : 1),
      updatedAt: Date.now(),
    });
    return await ctx.db.get(job._id);
  },
});

/** Provider signature verification belongs in the HTTP action. This mutation
 * accepts only the normalized result after verification and is internal-only. */
export const applyVerifiedWebhook = internalMutation({
  args: {
    providerEventId: v.string(),
    providerJobId: v.string(),
    providerStatus: v.string(),
    normalizedStatus: renderStatus,
    outputAssetId: v.optional(v.id("assets")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("renderEvents")
      .withIndex("by_provider_event", (q) => q.eq("providerEventId", args.providerEventId))
      .unique();
    if (duplicate) return { duplicate: true, renderJobId: duplicate.renderJobId };
    const job = await ctx.db
      .query("renderJobs")
      .withIndex("by_provider_job", (q) => q.eq("providerJobId", args.providerJobId))
      .unique();
    if (!job) {
      throw new ConvexError({ code: "RENDER_NOT_FOUND", message: "Webhook references an unknown render." });
    }
    const now = Date.now();
    await ctx.db.insert("renderEvents", {
      renderJobId: job._id,
      providerEventId: args.providerEventId,
      providerStatus: args.providerStatus,
      receivedAt: now,
    });
    // Terminal success is monotonic: a delayed provider callback cannot regress it.
    const normalizedStatus = job.status === "succeeded" ? "succeeded" : args.normalizedStatus;
    await ctx.db.patch(job._id, {
      status: normalizedStatus,
      outputAssetId: args.outputAssetId ?? job.outputAssetId,
      lastError: args.error,
      updatedAt: now,
      completedAt: normalizedStatus === "succeeded" ? now : job.completedAt,
    });
    if (normalizedStatus === "succeeded") {
      const burst = await ctx.db.get(job.burstId);
      if (burst && burst.status !== "complete") {
        await ctx.db.patch(burst._id, { status: "complete", updatedAt: now });
      }
    }
    return { duplicate: false, renderJobId: job._id };
  },
});

