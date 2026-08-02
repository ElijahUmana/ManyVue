import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import {
  assertHost,
  createCapabilityToken,
  createSessionSlug,
  hashCapability,
  publicSession,
} from "./lib/capabilities";
import { requireSessionBySlug } from "./lib/runtime";

function cleanOptional(value: string | undefined, maxLength: number) {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > maxLength) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `Text exceeds ${maxLength} characters.` });
  }
  return cleaned;
}

export const create = action({
  args: {
    title: v.string(),
    artistName: v.optional(v.string()),
    festivalName: v.optional(v.string()),
    stageName: v.optional(v.string()),
    jamBaseEventId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ sessionId: string; slug: string; hostCapability: string }> => {
    const title = args.title.trim();
    if (title.length < 2 || title.length > 120) {
      throw new ConvexError({ code: "INVALID_TITLE", message: "Session title must be 2-120 characters." });
    }
    const hostCapability = createCapabilityToken();
    const slug = createSessionSlug();
    const sessionId = await ctx.runMutation(internal.sessions.createInternal, {
      slug,
      title,
      hostCapabilityHash: await hashCapability(hostCapability),
      artistName: cleanOptional(args.artistName, 120),
      festivalName: cleanOptional(args.festivalName, 120),
      stageName: cleanOptional(args.stageName, 120),
      jamBaseEventId: cleanOptional(args.jamBaseEventId, 160),
    });
    return { sessionId, slug, hostCapability };
  },
});

export const createInternal = internalMutation({
  args: {
    slug: v.string(),
    title: v.string(),
    hostCapabilityHash: v.string(),
    artistName: v.optional(v.string()),
    festivalName: v.optional(v.string()),
    stageName: v.optional(v.string()),
    jamBaseEventId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const collision = await ctx.db
      .query("sessions")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (collision) {
      throw new ConvexError({ code: "SLUG_COLLISION", message: "Please retry session creation." });
    }
    return await ctx.db.insert("sessions", {
      ...args,
      status: "lobby",
      publicJoinEnabled: true,
      sceneRevision: 0,
      createdAt: Date.now(),
    });
  },
});

export const bySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => publicSession(await requireSessionBySlug(ctx, slug)),
});

export const setJoinEnabled = mutation({
  args: {
    sessionId: v.id("sessions"),
    hostCapability: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    if (session.status === "ended" && args.enabled) {
      throw new ConvexError({ code: "SESSION_ENDED", message: "An ended session cannot accept cameras." });
    }
    await ctx.db.patch(session._id, { publicJoinEnabled: args.enabled });
    return { enabled: args.enabled };
  },
});

export const startLive = mutation({
  args: { sessionId: v.id("sessions"), hostCapability: v.string() },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    if (session.status === "ended") {
      throw new ConvexError({ code: "SESSION_ENDED", message: "An ended session cannot be restarted." });
    }
    if (session.status === "live") return { startedAt: session.liveStartedAt };
    const startedAt = Date.now();
    await ctx.db.patch(session._id, { status: "live", liveStartedAt: startedAt });
    return { startedAt };
  },
});

export const endLive = mutation({
  args: { sessionId: v.id("sessions"), hostCapability: v.string() },
  handler: async (ctx, args) => {
    const session = await assertHost(ctx, args.sessionId, args.hostCapability);
    if (session.status === "ended") return { endedAt: session.endedAt };
    const endedAt = Date.now();
    await ctx.db.patch(session._id, {
      status: "ended",
      endedAt,
      publicJoinEnabled: false,
    });
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    await Promise.all(
      participants
        .filter((participant) => participant.recordingState === "recording")
        .map((participant) =>
          ctx.db.patch(participant._id, {
            recordingState: "uploading" as const,
            recordingStoppedAt: endedAt,
          }),
        ),
    );
    return { endedAt };
  },
});

