import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { assertHost, assertParticipant } from "./lib/capabilities";
import { assetKind } from "./validators";

const participantKinds = new Set(["original_clip", "burst_clip", "burst_frame"]);

function requireHttpsAssetUrl(value: string, field: string): string {
  if (value.length > 2_048) {
    throw new ConvexError({ code: "INVALID_EXTERNAL_ASSET", message: `${field} is too long.` });
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("not HTTPS");
    return url.toString();
  } catch {
    throw new ConvexError({ code: "INVALID_EXTERNAL_ASSET", message: `${field} must be a valid HTTPS URL.` });
  }
}

function externalAssetIdentity(value: string): string {
  const url = new URL(value);
  const key = url.searchParams.get("key");
  return key ? `${url.origin}${url.pathname}?key=${key}` : url.toString();
}

export const createParticipantUpload = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    clientAssetId: v.string(),
    kind: assetKind,
    burstId: v.optional(v.id("bursts")),
    mimeType: v.string(),
    startsAtServerMs: v.optional(v.number()),
    endsAtServerMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (!participantKinds.has(args.kind)) {
      throw new ConvexError({ code: "INVALID_ASSET_KIND", message: "Participants cannot upload this asset kind." });
    }
    if (!/^[a-zA-Z0-9_-]{8,160}$/u.test(args.clientAssetId)) {
      throw new ConvexError({ code: "INVALID_ASSET_ID", message: "A stable client asset ID is required." });
    }
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_participant_client_asset", (q) =>
        q.eq("participantId", participant._id).eq("clientAssetId", args.clientAssetId),
      )
      .unique();
    if (existing?.status === "ready") return { assetId: existing._id, uploadUrl: null, alreadyReady: true };
    if (args.kind.startsWith("burst_") && !args.burstId) {
      throw new ConvexError({ code: "BURST_REQUIRED", message: "Burst assets must reference their Burst." });
    }
    if (args.burstId) {
      const contribution = await ctx.db
        .query("burstContributions")
        .withIndex("by_burst_participant", (q) =>
          q.eq("burstId", args.burstId!).eq("participantId", participant._id),
        )
        .unique();
      if (!contribution) {
        throw new ConvexError({ code: "NOT_REQUESTED", message: "This camera was not requested for the Burst." });
      }
    }
    const now = Date.now();
    const assetId = existing
      ? existing._id
      : await ctx.db.insert("assets", {
          sessionId: participant.sessionId,
          participantId: participant._id,
          burstId: args.burstId,
          clientAssetId: args.clientAssetId,
          kind: args.kind,
          status: "pending",
          mimeType: args.mimeType,
          startsAtServerMs: args.startsAtServerMs,
          endsAtServerMs: args.endsAtServerMs,
          createdAt: now,
          updatedAt: now,
        });
    if (existing) await ctx.db.patch(existing._id, { status: "uploading", updatedAt: now });
    return { assetId, uploadUrl: await ctx.storage.generateUploadUrl(), alreadyReady: false };
  },
});

export const completeParticipantUpload = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    assetId: v.id("assets"),
    storageId: v.id("_storage"),
    byteLength: v.number(),
    sha256: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.participantId !== participant._id || asset.sessionId !== participant.sessionId) {
      throw new ConvexError({ code: "UNAUTHORIZED_ASSET", message: "Asset does not belong to this camera." });
    }
    if (asset.status === "ready") {
      if (asset.storageId !== args.storageId) {
        throw new ConvexError({ code: "ASSET_ALREADY_FINAL", message: "Asset was finalized with another upload." });
      }
      return { assetId: asset._id, duplicate: true };
    }
    if (!Number.isSafeInteger(args.byteLength) || args.byteLength <= 0) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "Uploaded asset must contain bytes." });
    }
    const now = Date.now();
    await ctx.db.patch(asset._id, {
      status: "ready",
      storageId: args.storageId,
      byteLength: args.byteLength,
      sha256: args.sha256,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      updatedAt: now,
    });
    if (asset.burstId) {
      const contribution = await ctx.db
        .query("burstContributions")
        .withIndex("by_burst_participant", (q) =>
          q.eq("burstId", asset.burstId!).eq("participantId", participant._id),
        )
        .unique();
      if (contribution && contribution.status !== "ready") {
        await ctx.db.patch(contribution._id, { status: "ready", assetId: asset._id, updatedAt: now });
        const burst = await ctx.db.get(asset.burstId);
        if (burst) {
          const readyContributionCount = burst.readyContributionCount + 1;
          const previewThreshold = Math.min(3, burst.expectedParticipantIds.length);
          await ctx.db.patch(burst._id, {
            readyContributionCount,
            status:
              burst.status === "collecting" && readyContributionCount >= previewThreshold
                ? "preview_ready"
                : burst.status,
            updatedAt: now,
          });
        }
      }
    }
    if (asset.kind === "original_clip" && participant.recordingState !== "recording") {
      await ctx.db.patch(participant._id, { recordingState: "ready", lastSeenAt: now });
    }
    return { assetId: asset._id, duplicate: false };
  },
});

/**
 * Sites stores immediately captured Burst microclips in R2 so Shotstack can
 * fetch them over HTTPS. This authenticated mutation mirrors that real asset
 * into Convex and advances the requested contribution exactly once.
 */
export const registerExternalBurstUpload = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    burstId: v.id("bursts"),
    clientAssetId: v.string(),
    clipUrl: v.string(),
    thumbnailUrl: v.optional(v.string()),
    mimeType: v.string(),
    byteLength: v.number(),
    durationMs: v.number(),
    startsAtServerMs: v.number(),
    endsAtServerMs: v.number(),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (!/^[a-zA-Z0-9_-]{8,160}$/u.test(args.clientAssetId)) {
      throw new ConvexError({ code: "INVALID_ASSET_ID", message: "A stable Burst asset ID is required." });
    }
    if (!Number.isSafeInteger(args.byteLength) || args.byteLength <= 0) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "The Burst microclip must contain bytes." });
    }
    if (!Number.isFinite(args.durationMs) || args.durationMs < 500 || args.durationMs > 20_000) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "Burst duration must be between 0.5 and 20 seconds." });
    }
    if (
      !Number.isFinite(args.startsAtServerMs) ||
      !Number.isFinite(args.endsAtServerMs) ||
      args.endsAtServerMs <= args.startsAtServerMs
    ) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "Burst server timestamps are invalid." });
    }
    const clipUrl = requireHttpsAssetUrl(args.clipUrl, "clipUrl");
    const thumbnailUrl = args.thumbnailUrl
      ? requireHttpsAssetUrl(args.thumbnailUrl, "thumbnailUrl")
      : undefined;
    const burst = await ctx.db.get(args.burstId);
    if (!burst || burst.sessionId !== participant.sessionId) {
      throw new ConvexError({ code: "BURST_NOT_FOUND", message: "Burst does not belong to this camera session." });
    }
    if (!burst.expectedParticipantIds.some((id) => id === participant._id)) {
      throw new ConvexError({ code: "NOT_REQUESTED", message: "This camera was not requested for the Burst." });
    }
    const contribution = await ctx.db
      .query("burstContributions")
      .withIndex("by_burst_participant", (q) =>
        q.eq("burstId", burst._id).eq("participantId", participant._id),
      )
      .unique();
    if (!contribution) {
      throw new ConvexError({ code: "NOT_REQUESTED", message: "The Burst contribution record is missing." });
    }

    const clipClientAssetId = `${args.clientAssetId}-clip`;
    const existingClip = await ctx.db
      .query("assets")
      .withIndex("by_participant_client_asset", (q) =>
        q.eq("participantId", participant._id).eq("clientAssetId", clipClientAssetId),
      )
      .unique();
    if (existingClip?.externalUrl && externalAssetIdentity(existingClip.externalUrl) !== externalAssetIdentity(clipUrl)) {
      throw new ConvexError({ code: "IDEMPOTENCY_CONFLICT", message: "Burst asset ID already points to another clip." });
    }
    const now = Date.now();
    const clipAssetId = existingClip?._id ?? await ctx.db.insert("assets", {
      sessionId: participant.sessionId,
      participantId: participant._id,
      burstId: burst._id,
      clientAssetId: clipClientAssetId,
      kind: "burst_clip",
      status: "ready",
      externalUrl: clipUrl,
      mimeType: args.mimeType.slice(0, 160),
      byteLength: args.byteLength,
      durationMs: Math.round(args.durationMs),
      startsAtServerMs: Math.round(args.startsAtServerMs),
      endsAtServerMs: Math.round(args.endsAtServerMs),
      createdAt: now,
      updatedAt: now,
    });
    if (existingClip) {
      await ctx.db.patch(existingClip._id, {
        status: "ready",
        externalUrl: clipUrl,
        mimeType: args.mimeType.slice(0, 160),
        byteLength: args.byteLength,
        durationMs: Math.round(args.durationMs),
        startsAtServerMs: Math.round(args.startsAtServerMs),
        endsAtServerMs: Math.round(args.endsAtServerMs),
        updatedAt: now,
      });
    }

    let thumbnailAssetId;
    if (thumbnailUrl) {
      const frameClientAssetId = `${args.clientAssetId}-frame`;
      const existingFrame = await ctx.db
        .query("assets")
        .withIndex("by_participant_client_asset", (q) =>
          q.eq("participantId", participant._id).eq("clientAssetId", frameClientAssetId),
        )
        .unique();
      if (existingFrame?.externalUrl && externalAssetIdentity(existingFrame.externalUrl) !== externalAssetIdentity(thumbnailUrl)) {
        throw new ConvexError({ code: "IDEMPOTENCY_CONFLICT", message: "Burst asset ID already points to another frame." });
      }
      thumbnailAssetId = existingFrame?._id ?? await ctx.db.insert("assets", {
        sessionId: participant.sessionId,
        participantId: participant._id,
        burstId: burst._id,
        clientAssetId: frameClientAssetId,
        kind: "burst_frame",
        status: "ready",
        externalUrl: thumbnailUrl,
        mimeType: "image/jpeg",
        createdAt: now,
        updatedAt: now,
      });
      if (existingFrame) {
        await ctx.db.patch(existingFrame._id, {
          status: "ready",
          externalUrl: thumbnailUrl,
          mimeType: "image/jpeg",
          updatedAt: now,
        });
      }
    }

    const duplicate = contribution.status === "ready";
    if (!duplicate) {
      await ctx.db.patch(contribution._id, {
        status: "ready",
        assetId: clipAssetId,
        failureReason: undefined,
        updatedAt: now,
      });
      const readyContributionCount = burst.readyContributionCount + 1;
      const previewThreshold = Math.min(3, burst.expectedParticipantIds.length);
      await ctx.db.patch(burst._id, {
        readyContributionCount,
        status:
          burst.status === "collecting" && readyContributionCount >= previewThreshold
            ? "preview_ready"
            : burst.status,
        updatedAt: now,
      });
    }
    return { clipAssetId, thumbnailAssetId, duplicate };
  },
});

/**
 * Registers the Program View's redundant recording of an expected phone. The
 * media remains owned by that phone participant; host authority only supplies
 * a safety copy when the mobile browser cannot finalize a local fragment.
 */
export const registerExternalBurstUploadByHost = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    participantId: v.id("participants"),
    burstId: v.id("bursts"),
    clientAssetId: v.string(),
    clipUrl: v.string(),
    mimeType: v.string(),
    byteLength: v.number(),
    durationMs: v.number(),
    startsAtServerMs: v.number(),
    endsAtServerMs: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    const [participant, burst] = await Promise.all([
      ctx.db.get(args.participantId),
      ctx.db.get(args.burstId),
    ]);
    if (
      !participant ||
      !burst ||
      participant.sessionId !== session._id ||
      burst.sessionId !== session._id ||
      !burst.expectedParticipantIds.includes(participant._id)
    ) {
      throw new ConvexError({ code: "NOT_REQUESTED", message: "Host mirror is not an expected Burst camera." });
    }
    if (!/^[a-zA-Z0-9_-]{8,160}$/u.test(args.clientAssetId)) {
      throw new ConvexError({ code: "INVALID_ASSET_ID", message: "A stable Burst asset ID is required." });
    }
    if (!Number.isSafeInteger(args.byteLength) || args.byteLength <= 0) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "The Burst microclip must contain bytes." });
    }
    if (!Number.isFinite(args.durationMs) || args.durationMs < 500 || args.durationMs > 20_000) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "Burst duration must be between 0.5 and 20 seconds." });
    }
    if (
      !Number.isFinite(args.startsAtServerMs) ||
      !Number.isFinite(args.endsAtServerMs) ||
      args.endsAtServerMs <= args.startsAtServerMs
    ) {
      throw new ConvexError({ code: "INVALID_ASSET", message: "Burst server timestamps are invalid." });
    }
    const contribution = await ctx.db
      .query("burstContributions")
      .withIndex("by_burst_participant", (q) =>
        q.eq("burstId", burst._id).eq("participantId", participant._id),
      )
      .unique();
    if (!contribution) {
      throw new ConvexError({ code: "NOT_REQUESTED", message: "The Burst contribution record is missing." });
    }

    const clipUrl = requireHttpsAssetUrl(args.clipUrl, "clipUrl");
    const clipClientAssetId = `${args.clientAssetId}-clip`;
    const existingClip = await ctx.db
      .query("assets")
      .withIndex("by_participant_client_asset", (q) =>
        q.eq("participantId", participant._id).eq("clientAssetId", clipClientAssetId),
      )
      .unique();
    if (existingClip?.externalUrl && externalAssetIdentity(existingClip.externalUrl) !== externalAssetIdentity(clipUrl)) {
      throw new ConvexError({ code: "IDEMPOTENCY_CONFLICT", message: "Burst asset ID already points to another clip." });
    }
    const now = Date.now();
    const clipAssetId = existingClip?._id ?? await ctx.db.insert("assets", {
      sessionId: session._id,
      participantId: participant._id,
      burstId: burst._id,
      clientAssetId: clipClientAssetId,
      kind: "burst_clip",
      status: "ready",
      externalUrl: clipUrl,
      mimeType: args.mimeType.slice(0, 160),
      byteLength: args.byteLength,
      durationMs: Math.round(args.durationMs),
      startsAtServerMs: Math.round(args.startsAtServerMs),
      endsAtServerMs: Math.round(args.endsAtServerMs),
      createdAt: now,
      updatedAt: now,
    });
    if (existingClip) {
      await ctx.db.patch(existingClip._id, {
        status: "ready",
        externalUrl: clipUrl,
        mimeType: args.mimeType.slice(0, 160),
        byteLength: args.byteLength,
        durationMs: Math.round(args.durationMs),
        startsAtServerMs: Math.round(args.startsAtServerMs),
        endsAtServerMs: Math.round(args.endsAtServerMs),
        updatedAt: now,
      });
    }

    const duplicate = contribution.status === "ready";
    if (!duplicate) {
      await ctx.db.patch(contribution._id, {
        status: "ready",
        assetId: clipAssetId,
        failureReason: undefined,
        updatedAt: now,
      });
      const readyContributionCount = burst.readyContributionCount + 1;
      const previewThreshold = Math.min(3, burst.expectedParticipantIds.length);
      await ctx.db.patch(burst._id, {
        readyContributionCount,
        status:
          burst.status === "collecting" && readyContributionCount >= previewThreshold
            ? "preview_ready"
            : burst.status,
        updatedAt: now,
      });
    }
    return { clipAssetId, duplicate };
  },
});

export const createHostUpload = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    clientAssetId: v.string(),
    kind: assetKind,
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    if (args.kind !== "master_audio" && args.kind !== "program_recording") {
      throw new ConvexError({ code: "INVALID_HOST_ASSET", message: "Host upload kind is not supported." });
    }
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .filter((q) => q.eq(q.field("clientAssetId"), args.clientAssetId))
      .unique();
    const now = Date.now();
    const assetId = existing?._id ??
      (await ctx.db.insert("assets", {
        sessionId: session._id,
        clientAssetId: args.clientAssetId,
        kind: args.kind,
        status: "pending",
        mimeType: args.mimeType,
        createdAt: now,
        updatedAt: now,
      }));
    return { assetId, uploadUrl: await ctx.storage.generateUploadUrl(), alreadyReady: existing?.status === "ready" };
  },
});

export const completeHostUpload = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    assetId: v.id("assets"),
    storageId: v.id("_storage"),
    byteLength: v.number(),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    const asset = await ctx.db.get(args.assetId);
    if (
      !asset ||
      asset.sessionId !== session._id ||
      (asset.kind !== "master_audio" && asset.kind !== "program_recording")
    ) {
      throw new ConvexError({ code: "UNAUTHORIZED_ASSET", message: "Host asset does not belong to this session." });
    }
    if (asset.status === "ready") {
      if (asset.storageId !== args.storageId) {
        throw new ConvexError({ code: "ASSET_ALREADY_FINAL", message: "Asset was finalized with another upload." });
      }
      return { assetId: asset._id, duplicate: true };
    }
    const now = Date.now();
    await ctx.db.patch(asset._id, {
      status: "ready",
      storageId: args.storageId,
      byteLength: args.byteLength,
      durationMs: args.durationMs,
      updatedAt: now,
    });
    return { assetId: asset._id, duplicate: false };
  },
});

export const mine = query({
  args: { participantId: v.id("participants"), participantCapability: v.string() },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const assets = await ctx.db
      .query("assets")
      .withIndex("by_participant_client_asset", (q) => q.eq("participantId", participant._id))
      .collect();
    return await Promise.all(
      assets.map(async (asset) => ({
        ...asset,
        url: asset.storageId ? await ctx.storage.getUrl(asset.storageId) : asset.externalUrl,
      })),
    );
  },
});

export const registerRenderOutput = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    participantId: v.id("participants"),
    burstId: v.id("bursts"),
    renderJobId: v.id("renderJobs"),
    storageId: v.optional(v.id("_storage")),
    externalUrl: v.optional(v.string()),
    mimeType: v.string(),
    byteLength: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.storageId && !args.externalUrl) {
      throw new ConvexError({ code: "OUTPUT_MISSING", message: "Rendered output requires storage or an external URL." });
    }
    const now = Date.now();
    return await ctx.db.insert("assets", {
      sessionId: args.sessionId,
      participantId: args.participantId,
      burstId: args.burstId,
      clientAssetId: `render_${args.renderJobId}`,
      kind: "render_output",
      status: "ready",
      storageId: args.storageId,
      externalUrl: args.externalUrl,
      mimeType: args.mimeType,
      byteLength: args.byteLength,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      createdAt: now,
      updatedAt: now,
    });
  },
});
