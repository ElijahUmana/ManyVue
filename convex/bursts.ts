import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { assertHost, assertParticipant } from "./lib/capabilities";
import { participantIsLiveCamera } from "./lib/runtime";
import {
  BURST_CONTRIBUTION_DEADLINE_MS,
  BURST_WINDOW_AFTER_MS,
  BURST_WINDOW_BEFORE_MS,
} from "../lib/realtime/constants";
import { shouldJoinBurstCluster } from "../lib/realtime/burst-clustering";

async function activeRecordingParticipants(ctx: MutationCtx, sessionId: Id<"sessions">, now: number) {
  const participants = await ctx.db
    .query("participants")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return participants.filter(
    (participant) => participant.role !== "presenter" && participantIsLiveCamera(participant, now),
  );
}

function assertClientMarkerId(clientMarkerId: string) {
  if (!/^[a-zA-Z0-9_-]{8,120}$/u.test(clientMarkerId)) {
    throw new ConvexError({ code: "INVALID_MARKER_ID", message: "A stable client marker ID is required." });
  }
}

async function createOrJoinBurst(
  ctx: MutationCtx,
  args: {
    session: Doc<"sessions">;
    actorParticipantId: Id<"participants">;
    active: Doc<"participants">[];
    clientMarkerId: string;
    clientObservedAtMs?: number;
    clockOffsetMs?: number;
    now: number;
  },
) {
  assertClientMarkerId(args.clientMarkerId);
  const duplicate = await ctx.db
    .query("burstMarkers")
    .withIndex("by_participant_client_marker", (q) =>
      q.eq("participantId", args.actorParticipantId).eq("clientMarkerId", args.clientMarkerId),
    )
    .unique();
  if (duplicate) {
    return { duplicate: true, markerId: duplicate._id, burst: await ctx.db.get(duplicate.burstId) };
  }

  const latest = await ctx.db
    .query("bursts")
    .withIndex("by_session_anchor", (q) => q.eq("sessionId", args.session._id))
    .order("desc")
    .first();

  let burstId: Id<"bursts">;
  if (shouldJoinBurstCluster(latest, args.now)) {
    burstId = latest!._id;
    const initiators = latest!.initiatorParticipantIds.includes(args.actorParticipantId)
      ? latest!.initiatorParticipantIds
      : [...latest!.initiatorParticipantIds, args.actorParticipantId];
    const expected = new Set(latest!.expectedParticipantIds.map(String));
    const expectedParticipantIds = [...latest!.expectedParticipantIds];
    for (const camera of args.active) {
      if (expected.has(String(camera._id))) continue;
      expected.add(String(camera._id));
      expectedParticipantIds.push(camera._id);
      await ctx.db.insert("burstContributions", {
        sessionId: args.session._id,
        burstId,
        participantId: camera._id,
        status: "requested",
        updatedAt: args.now,
      });
    }
    await ctx.db.patch(burstId, {
      // Once phones receive a Burst window it is immutable. Later taps join
      // the shared moment without moving the cue underneath earlier cameras.
      contributionDeadlineMs: Math.min(
        latest!.createdAt + 12_000,
        Math.max(latest!.contributionDeadlineMs, args.now + BURST_CONTRIBUTION_DEADLINE_MS),
      ),
      initiatorParticipantIds: initiators,
      expectedParticipantIds,
      markerCount: latest!.markerCount + 1,
      updatedAt: args.now,
    });
  } else {
    burstId = await ctx.db.insert("bursts", {
      sessionId: args.session._id,
      anchorServerMs: args.now,
      windowStartServerMs: args.now - BURST_WINDOW_BEFORE_MS,
      windowEndServerMs: args.now + BURST_WINDOW_AFTER_MS,
      contributionDeadlineMs: args.now + BURST_CONTRIBUTION_DEADLINE_MS,
      initiatorParticipantIds: [args.actorParticipantId],
      expectedParticipantIds: args.active.map((camera) => camera._id),
      markerCount: 1,
      readyContributionCount: 0,
      acknowledgedContributionCount: 0,
      status: "collecting",
      createdAt: args.now,
      updatedAt: args.now,
    });
    for (const camera of args.active) {
      await ctx.db.insert("burstContributions", {
        sessionId: args.session._id,
        burstId,
        participantId: camera._id,
        status: "requested",
        updatedAt: args.now,
      });
    }
  }

  const markerId = await ctx.db.insert("burstMarkers", {
    sessionId: args.session._id,
    burstId,
    participantId: args.actorParticipantId,
    clientMarkerId: args.clientMarkerId,
    markerServerMs: args.now,
    clientObservedAtMs: args.clientObservedAtMs,
    clockOffsetMs: args.clockOffsetMs,
    createdAt: args.now,
  });
  return { duplicate: false, markerId, burst: await ctx.db.get(burstId) };
}

export const trigger = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    clientMarkerId: v.string(),
    clientObservedAtMs: v.optional(v.number()),
    clockOffsetMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    if (participant.role === "presenter") {
      throw new ConvexError({ code: "USE_HOST_TRIGGER", message: "Program View must cue Burst through the host control path." });
    }
    if (participant.recordingState !== "recording") {
      throw new ConvexError({ code: "NOT_RECORDING", message: "Start your angle before catching a Burst." });
    }
    const session = await ctx.db.get(participant.sessionId);
    if (!session || session.status !== "live") {
      throw new ConvexError({ code: "SESSION_NOT_LIVE", message: "Bursts are available during the live production." });
    }
    const now = Date.now();
    // An authenticated Burst tap is itself a fresh presence signal. Mobile
    // timer throttling must not make a recording fan unable to catch a moment.
    await ctx.db.patch(participant._id, {
      connectionState: "online",
      lastSeenAt: now,
      disconnectedAt: undefined,
      leftAt: undefined,
    });
    const refreshedParticipant = { ...participant, connectionState: "online" as const, lastSeenAt: now, leftAt: undefined };
    const active = await activeRecordingParticipants(ctx, session._id, now);
    if (!participantIsLiveCamera(refreshedParticipant, now)) {
      throw new ConvexError({ code: "CAMERA_NOT_LIVE", message: "Your camera must be live to trigger a Burst." });
    }
    if (!active.some((camera) => camera._id === participant._id)) active.push(refreshedParticipant);
    return await createOrJoinBurst(ctx, {
      session,
      actorParticipantId: participant._id,
      active,
      clientMarkerId: args.clientMarkerId,
      clientObservedAtMs: args.clientObservedAtMs,
      clockOffsetMs: args.clockOffsetMs,
      now,
    });
  },
});

export const triggerByHost = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    actorParticipantId: v.id("participants"),
    clientMarkerId: v.string(),
    clientObservedAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    if (session.status !== "live") {
      throw new ConvexError({ code: "SESSION_NOT_LIVE", message: "Start the live production before cueing a Burst." });
    }
    const actor = await ctx.db.get(args.actorParticipantId);
    if (!actor || actor.sessionId !== session._id || actor.role !== "presenter") {
      throw new ConvexError({ code: "INVALID_HOST_ACTOR", message: "The Program View presenter is not part of this session." });
    }
    const now = Date.now();
    const active = await activeRecordingParticipants(ctx, session._id, now);
    if (!active.length) {
      throw new ConvexError({ code: "NO_LIVE_CAMERAS", message: "At least one recording crowd camera is required for a Burst." });
    }
    return await createOrJoinBurst(ctx, {
      session,
      actorParticipantId: actor._id,
      active,
      clientMarkerId: args.clientMarkerId,
      clientObservedAtMs: args.clientObservedAtMs,
      now,
    });
  },
});

export const acknowledgePreserved = mutation({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    burstId: v.id("bursts"),
    preservedStartMs: v.number(),
    preservedEndMs: v.number(),
    captureSkewMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const contribution = await ctx.db
      .query("burstContributions")
      .withIndex("by_burst_participant", (q) =>
        q.eq("burstId", args.burstId).eq("participantId", participant._id),
      )
      .unique();
    if (!contribution) {
      throw new ConvexError({ code: "NOT_REQUESTED", message: "This camera was not part of the Burst." });
    }
    if (args.preservedEndMs <= args.preservedStartMs || args.preservedEndMs - args.preservedStartMs > 15_000) {
      throw new ConvexError({ code: "INVALID_WINDOW", message: "Preserved Burst window is invalid." });
    }
    const alreadyAcknowledged = contribution.status === "preserved" || contribution.status === "uploading" || contribution.status === "ready";
    if (alreadyAcknowledged) {
      return { contributionId: contribution._id, duplicate: true };
    }
    const burst = await ctx.db.get(args.burstId);
    if (!burst || burst.sessionId !== participant.sessionId) {
      throw new ConvexError({ code: "BURST_NOT_FOUND", message: "Burst does not belong to this session." });
    }
    const acknowledgedContributionCount = (burst.acknowledgedContributionCount ?? 0) + 1;
    const previewThreshold = Math.min(3, burst.expectedParticipantIds.length);
    const nextBurstStatus =
      burst.status === "collecting" && acknowledgedContributionCount >= previewThreshold
        ? "preview_ready" as const
        : burst.status;
    await ctx.db.patch(contribution._id, {
      status: "preserved",
      preservedStartMs: args.preservedStartMs,
      preservedEndMs: args.preservedEndMs,
      captureSkewMs: args.captureSkewMs,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(burst._id, {
      acknowledgedContributionCount,
      status: nextBurstStatus,
      updatedAt: Date.now(),
    });
    return { contributionId: contribution._id, duplicate: false, acknowledgedContributionCount };
  },
});

export const mine = query({
  args: { participantId: v.id("participants"), participantCapability: v.string() },
  handler: async (ctx, args) => {
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const markers = await ctx.db
      .query("burstMarkers")
      .withIndex("by_participant_client_marker", (q) => q.eq("participantId", participant._id))
      .collect();
    return await Promise.all(
      markers.map(async (marker) => ({ marker, burst: await ctx.db.get(marker.burstId) })),
    );
  },
});

export const recentHistory = query({
  args: {
    participantId: v.id("participants"),
    participantCapability: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // The participant capability is the authority boundary. Deriving the
    // session from the authenticated participant prevents callers from using a
    // valid token to inspect another session's Burst history.
    const participant = await assertParticipant(ctx, args.participantId, args.participantCapability);
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ConvexError({
        code: "INVALID_LIMIT",
        message: "Burst history limit must be an integer between 1 and 50.",
      });
    }

    const bursts = await ctx.db
      .query("bursts")
      .withIndex("by_session_anchor", (q) => q.eq("sessionId", participant.sessionId))
      .order("desc")
      .take(limit);

    const items = await Promise.all(
      bursts.map(async (burst) => {
        const contribution = await ctx.db
          .query("burstContributions")
          .withIndex("by_burst_participant", (q) =>
            q.eq("burstId", burst._id).eq("participantId", participant._id),
          )
          .unique();
        const contributed = Boolean(
          contribution && (
            contribution.status === "preserved" ||
            contribution.status === "uploading" ||
            contribution.status === "ready" ||
            contribution.preservedStartMs !== undefined ||
            contribution.assetId !== undefined
          ),
        );

        return {
          burstId: burst._id,
          anchorServerMs: burst.anchorServerMs,
          windowStartServerMs: burst.windowStartServerMs,
          windowEndServerMs: burst.windowEndServerMs,
          contributionDeadlineMs: burst.contributionDeadlineMs,
          state: burst.status,
          counts: {
            markers: burst.markerCount,
            expected: burst.expectedParticipantIds.length,
            acknowledged: burst.acknowledgedContributionCount ?? 0,
            ready: burst.readyContributionCount,
          },
          wasInitiator: burst.initiatorParticipantIds.includes(participant._id),
          wasExpected: burst.expectedParticipantIds.includes(participant._id),
          contributed,
          contributionStatus: contribution?.status ?? null,
          contributionUpdatedAt: contribution?.updatedAt ?? null,
          createdAt: burst.createdAt,
          updatedAt: burst.updatedAt,
        };
      }),
    );

    return {
      sessionId: participant.sessionId,
      participantId: participant._id,
      items,
    };
  },
});
