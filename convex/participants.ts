import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import {
  assertParticipant,
  createCapabilityToken,
  hashCapability,
  publicParticipant,
} from "./lib/capabilities";
import { participantIsLiveCamera, requireSessionBySlug } from "./lib/runtime";
import { connectionState, deviceInfo, mediaHealth, participantRole } from "./validators";
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
      joinedAt: now,
      lastSeenAt: now,
      lastClientSequence: 0,
    });
    const livekitIdentity = String(participantId);
    await ctx.db.patch(participantId, { livekitIdentity });
    return { participantId, livekitIdentity, sessionId: session._id };
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

export const activeBySession = query({
  args: { sessionSlug: v.string() },
  handler: async (ctx, { sessionSlug }) => {
    const session = await requireSessionBySlug(ctx, sessionSlug);
    const now = Date.now();
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    return participants.filter((participant) => participantIsLiveCamera(participant, now)).map(publicParticipant);
  },
});

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PRESENCE_STALE_AFTER_MS;
    const stale = await ctx.db
      .query("participants")
      .withIndex("by_last_seen", (q) => q.lt("lastSeenAt", cutoff))
      .take(100);
    let expired = 0;
    for (const participant of stale) {
      if (participant.connectionState === "offline" || participant.leftAt !== undefined) continue;
      await ctx.db.patch(participant._id, {
        connectionState: "offline",
        disconnectedAt: Date.now(),
      });
      expired += 1;
    }
    return { expired };
  },
});
