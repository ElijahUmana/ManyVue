import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import {
  assertParticipant,
  createCapabilityToken,
  hashCapability,
  publicParticipant,
  assertHost,
} from "./lib/capabilities";
import {
  connectedParticipantsBySessionSince,
  participantIsLiveCamera,
  requireSessionBySlug,
} from "./lib/runtime";
import { expireStalePresence } from "./lib/presence_expiry";
import { connectionState, deviceInfo, mediaHealth, participantRole, shotMetadataInput } from "./validators";
import { PRESENCE_STALE_AFTER_MS } from "../lib/realtime/constants";

function assertSequence(previous: number, incoming: number) {
  if (!Number.isSafeInteger(incoming) || incoming < 1) {
    throw new ConvexError({ code: "INVALID_SEQUENCE", message: "Client sequence must be a positive integer." });
  }
  return incoming > previous;
}

export const join = action({
  args: {
    sessionSlug: v.string(),
    displayName: v.optional(v.string()),
    role: v.optional(participantRole),
    deviceInfo: v.optional(deviceInfo),
    shotMetadata: v.optional(shotMetadataInput),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    participantId: string;
    participantCapability: string;
    livekitIdentity: string;
    sessionId: string;
  }> => {
    const participantCapability = createCapabilityToken();
    const identitySuffix = createCapabilityToken().slice(0, 14);
    const joined = await ctx.runMutation(internal.participants.joinInternal, {
      sessionSlug: args.sessionSlug.trim().toLowerCase(),
      displayName: args.displayName?.trim().slice(0, 60),
      role: args.role ?? "attendee",
      deviceInfo: args.deviceInfo,
      shotMetadata: args.shotMetadata,
      capabilityHash: await hashCapability(participantCapability),
      livekitIdentity: `camera_${identitySuffix}`,
    });
    return { ...joined, participantCapability };
  },
});

export const joinInternal = internalMutation({
  args: {
    sessionSlug: v.string(),
    displayName: v.optional(v.string()),
    role: participantRole,
    deviceInfo: v.optional(deviceInfo),
    shotMetadata: v.optional(shotMetadataInput),
    capabilityHash: v.string(),
    livekitIdentity: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await requireSessionBySlug(ctx, args.sessionSlug);
    if (!session.publicJoinEnabled || session.status === "ended") {
      throw new ConvexError({ code: "JOIN_CLOSED", message: "This camera session is not accepting joins." });
    }
    const now = Date.now();
    const participantId = await ctx.db.insert("participants", {
      sessionId: session._id,
      capabilityHash: args.capabilityHash,
      displayName: args.displayName || undefined,
      role: args.role,
      livekitIdentity: args.livekitIdentity,
      connectionState: "online",
      recordingState: "idle",
      deviceInfo: args.deviceInfo,
      shotMetadata: args.shotMetadata ? { ...args.shotMetadata, updatedAt: now } : undefined,
      joinedAt: now,
      lastSeenAt: now,
      lastClientSequence: 0,
    });
    const livekitIdentity = String(participantId);
    await ctx.db.patch(participantId, { livekitIdentity });
    return { participantId, livekitIdentity, sessionId: session._id };
  },
});

export const updateShotMetadata = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    shotMetadata: shotMetadataInput,
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const confidence = args.shotMetadata.confidence;
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new ConvexError({ code: "INVALID_CONFIDENCE", message: "Camera confidence must be between 0 and 1." });
    }
    const updatedAt = Date.now();
    await ctx.db.patch(participant._id, {
      shotMetadata: { ...args.shotMetadata, updatedAt },
      lastSeenAt: updatedAt,
    });
    return { shotMetadata: { ...args.shotMetadata, updatedAt } };
  },
});

export const assignShotMetadata = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    participantId: v.id("participants"),
    shotMetadata: shotMetadataInput,
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    const participant = await ctx.db.get(args.participantId);
    if (!participant || participant.sessionId !== session._id) {
      throw new ConvexError({ code: "CAMERA_NOT_FOUND", message: "Camera does not belong to this session." });
    }
    const updatedAt = Date.now();
    const shotMetadata = { ...args.shotMetadata, source: "host" as const, updatedAt };
    await ctx.db.patch(participant._id, { shotMetadata });
    return { shotMetadata };
  },
});

export const heartbeat = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    clientSequence: v.number(),
    connectionState: connectionState,
    mediaHealth: v.optional(mediaHealth),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (!assertSequence(participant.lastClientSequence, args.clientSequence)) {
      return { accepted: false, serverNowMs: Date.now() };
    }
    const now = Date.now();
    await ctx.db.patch(participant._id, {
      connectionState: args.connectionState,
      mediaHealth: args.mediaHealth ?? participant.mediaHealth,
      lastSeenAt: now,
      disconnectedAt: args.connectionState === "offline" ? now : undefined,
      lastClientSequence: args.clientSequence,
      leftAt: undefined,
    });
    return { accepted: true, serverNowMs: now };
  },
});

export const beginRecording = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    clientSequence: v.number(),
    deviceInfo: v.optional(deviceInfo),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (!assertSequence(participant.lastClientSequence, args.clientSequence)) {
      return { accepted: false, recordingStartedAt: participant.recordingStartedAt };
    }
    const session = await ctx.db.get(participant.sessionId);
    if (!session || session.status === "ended") {
      throw new ConvexError({ code: "SESSION_ENDED", message: "Recording is closed for this session." });
    }
    const now = Date.now();
    await ctx.db.patch(participant._id, {
      recordingState: "recording",
      connectionState: "online",
      recordingStartedAt: now,
      recordingStoppedAt: undefined,
      lastSeenAt: now,
      lastClientSequence: args.clientSequence,
      deviceInfo: args.deviceInfo ?? participant.deviceInfo,
    });
    return { accepted: true, recordingStartedAt: now, serverNowMs: now };
  },
});

export const stopRecording = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    clientSequence: v.number(),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (!assertSequence(participant.lastClientSequence, args.clientSequence)) {
      return { accepted: false, recordingStoppedAt: participant.recordingStoppedAt };
    }
    const now = Date.now();
    await ctx.db.patch(participant._id, {
      recordingState: "uploading",
      recordingStoppedAt: now,
      lastSeenAt: now,
      lastClientSequence: args.clientSequence,
    });
    return { accepted: true, recordingStoppedAt: now, serverNowMs: now };
  },
});

export const markOriginalReady = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (participant.recordingState === "recording") {
      throw new ConvexError({ code: "STILL_RECORDING", message: "Stop recording before finalizing the original." });
    }
    await ctx.db.patch(participant._id, { recordingState: "ready", lastSeenAt: Date.now() });
    return { ready: true };
  },
});

export const leave = mutation({
  args: { participantId: v.id("participants"), participantCapability: v.string() },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const now = Date.now();
    await ctx.db.patch(participant._id, {
      connectionState: "offline",
      leftAt: now,
      disconnectedAt: now,
      lastSeenAt: now,
    });
    return { leftAt: now };
  },
});

export const me = query({
  args: { participantId: v.id("participants"), participantCapability: v.string() },
  handler: async (ctx, args) => publicParticipant(await assertParticipant(ctx, args.participantId, args.participantCapability)),
});

/** Authorizes a camera's media-plane identity without ever returning its
 * capability. The token service calls this server-to-server before minting a
 * LiveKit credential, so a caller cannot impersonate another participant by
 * editing query parameters. */
export const authorizeLiveMedia = query({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    sessionSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const session = await requireSessionBySlug(ctx, args.sessionSlug.trim().toLowerCase());
    if (participant.sessionId !== session._id || participant.role !== "attendee") {
      throw new ConvexError({ code: "MEDIA_FORBIDDEN", message: "Camera identity does not belong to this session." });
    }
    if (session.status === "ended" || !session.publicJoinEnabled) {
      throw new ConvexError({ code: "SESSION_CLOSED", message: "This camera room is closed." });
    }
    return {
      room: session.slug,
      identity: participant.livekitIdentity,
      displayName: participant.displayName ?? "Crowd Camera",
      role: participant.role,
    };
  },
});

export const activeBySession = query({
  args: { sessionSlug: v.string() },
  handler: async (ctx, { sessionSlug }) => {
    const session = await requireSessionBySlug(ctx, sessionSlug);
    const now = Date.now();
    const participants = await connectedParticipantsBySessionSince(
      ctx,
      session._id,
      now - PRESENCE_STALE_AFTER_MS,
    );
    return participants.filter((participant) => participantIsLiveCamera(participant, now)).map(publicParticipant);
  },
});

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return await expireStalePresence({
      cutoffMs: now - PRESENCE_STALE_AFTER_MS,
      disconnectedAtMs: now,
      store: {
        findStaleByState: async (connectionState, cutoffMs, limit) =>
          await ctx.db
            .query("participants")
            .withIndex("by_connection_state_last_seen", (q) =>
              q.eq("connectionState", connectionState).lt("lastSeenAt", cutoffMs),
            )
            .take(limit),
        markOffline: async (participant, disconnectedAtMs) => {
          await ctx.db.patch(participant._id, {
            connectionState: "offline",
            disconnectedAt: disconnectedAtMs,
          });
        },
      },
    });
  },
});
