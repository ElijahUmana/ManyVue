import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { assertParticipant } from "./lib/capabilities";
import { participantIsLiveCamera } from "./lib/runtime";
import {
  BURST_CONTRIBUTION_DEADLINE_MS,
  BURST_WINDOW_AFTER_MS,
  BURST_WINDOW_BEFORE_MS,
} from "../lib/realtime/constants";
import { mergedBurstAnchor, shouldJoinBurstCluster } from "../lib/realtime/burst-clustering";

async function activeRecordingParticipants(ctx: MutationCtx, sessionId: Id<"sessions">, now: number) {
  const participants = await ctx.db
    .query("participants")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return participants.filter((participant) => participantIsLiveCamera(participant, now));
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
    if (participant.recordingState !== "recording") {
      throw new ConvexError({ code: "NOT_RECORDING", message: "Start your angle before catching a Burst." });
    }
    if (!/^[a-zA-Z0-9_-]{8,120}$/u.test(args.clientMarkerId)) {
      throw new ConvexError({ code: "INVALID_MARKER_ID", message: "A stable client marker ID is required." });
    }
    const duplicate = await ctx.db
      .query("burstMarkers")
      .withIndex("by_participant_client_marker", (q) =>
        q.eq("participantId", participant._id).eq("clientMarkerId", args.clientMarkerId),
      )
      .unique();
    if (duplicate) {
      const burst = await ctx.db.get(duplicate.burstId);
      return { duplicate: true, markerId: duplicate._id, burst };
    }
    const session = await ctx.db.get(participant.sessionId);
    if (!session || session.status !== "live") {
      throw new ConvexError({ code: "SESSION_NOT_LIVE", message: "Bursts are available during the live production." });
    }
    const now = Date.now();
    const active = await activeRecordingParticipants(ctx, session._id, now);
    if (!active.some((camera) => camera._id === participant._id)) {
      throw new ConvexError({ code: "CAMERA_NOT_LIVE", message: "Your camera must be live to trigger a Burst." });
    }
    const latest = await ctx.db
      .query("bursts")
      .withIndex("by_session_anchor", (q) => q.eq("sessionId", session._id))
      .order("desc")
      .first();

    let burstId;
    if (shouldJoinBurstCluster(latest, now)) {
      burstId = latest!._id;
      const anchor = mergedBurstAnchor(latest!.anchorServerMs, now, latest!.markerCount);
      const initiators = latest!.initiatorParticipantIds.includes(participant._id)
        ? latest!.initiatorParticipantIds
        : [...latest!.initiatorParticipantIds, participant._id];
      const expected = new Set(latest!.expectedParticipantIds.map(String));
      const expectedParticipantIds = [...latest!.expectedParticipantIds];
      for (const camera of active) {
        if (expected.has(String(camera._id))) continue;
        expected.add(String(camera._id));
        expectedParticipantIds.push(camera._id);
        await ctx.db.insert("burstContributions", {
          sessionId: session._id,
          burstId,
          participantId: camera._id,
          status: "requested",
          updatedAt: now,
        });
      }
      await ctx.db.patch(burstId, {
        anchorServerMs: anchor,
        windowStartServerMs: anchor - BURST_WINDOW_BEFORE_MS,
        windowEndServerMs: anchor + BURST_WINDOW_AFTER_MS,
        contributionDeadlineMs: Math.min(
          latest!.createdAt + 12_000,
          Math.max(latest!.contributionDeadlineMs, now + BURST_CONTRIBUTION_DEADLINE_MS),
        ),
        initiatorParticipantIds: initiators,
        expectedParticipantIds,
        markerCount: latest!.markerCount + 1,
        updatedAt: now,
      });
    } else {
      burstId = await ctx.db.insert("bursts", {
        sessionId: session._id,
        anchorServerMs: now,
        windowStartServerMs: now - BURST_WINDOW_BEFORE_MS,
        windowEndServerMs: now + BURST_WINDOW_AFTER_MS,
        contributionDeadlineMs: now + BURST_CONTRIBUTION_DEADLINE_MS,
        initiatorParticipantIds: [participant._id],
        expectedParticipantIds: active.map((camera) => camera._id),
        markerCount: 1,
        readyContributionCount: 0,
        status: "collecting",
        createdAt: now,
        updatedAt: now,
      });
      for (const camera of active) {
        await ctx.db.insert("burstContributions", {
          sessionId: session._id,
          burstId,
          participantId: camera._id,
          status: "requested",
          updatedAt: now,
        });
      }
    }
    const markerId = await ctx.db.insert("burstMarkers", {
      sessionId: session._id,
      burstId,
      participantId: participant._id,
      clientMarkerId: args.clientMarkerId,
      markerServerMs: now,
      clientObservedAtMs: args.clientObservedAtMs,
      clockOffsetMs: args.clockOffsetMs,
      createdAt: now,
    });
    return { duplicate: false, markerId, burst: await ctx.db.get(burstId) };
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
    if (args.preservedEndMs <= args.preservedStartMs) {
      throw new ConvexError({ code: "INVALID_WINDOW", message: "Preserved Burst window is invalid." });
    }
    await ctx.db.patch(contribution._id, {
      status: contribution.status === "ready" ? "ready" : "preserved",
      preservedStartMs: args.preservedStartMs,
      preservedEndMs: args.preservedEndMs,
      captureSkewMs: args.captureSkewMs,
      updatedAt: Date.now(),
    });
    return { contributionId: contribution._id };
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
