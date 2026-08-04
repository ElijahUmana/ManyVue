import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  assetKind,
  assetStatus,
  burstStatus,
  connectionState,
  contributionStatus,
  deviceInfo,
  mediaHealth,
  participantRole,
  recordingState,
  renderStatus,
  shotMetadata,
  sceneLayout,
  sceneSource,
  sceneStatus,
  sessionStatus,
} from "./validators";

export default defineSchema({
  sessions: defineTable({
    slug: v.string(),
    title: v.string(),
    status: sessionStatus,
    hostCapabilityHash: v.string(),
    publicJoinEnabled: v.boolean(),
    artistName: v.optional(v.string()),
    festivalName: v.optional(v.string()),
    stageName: v.optional(v.string()),
    jamBaseEventId: v.optional(v.string()),
    currentSceneId: v.optional(v.id("scenes")),
    sceneRevision: v.number(),
    createdAt: v.number(),
    liveStartedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_status", ["status"]),

  participants: defineTable({
    sessionId: v.id("sessions"),
    capabilityHash: v.string(),
    displayName: v.optional(v.string()),
    role: participantRole,
    livekitIdentity: v.string(),
    connectionState,
    recordingState,
    deviceInfo: v.optional(deviceInfo),
    mediaHealth: v.optional(mediaHealth),
    shotMetadata: v.optional(shotMetadata),
    joinedAt: v.number(),
    lastSeenAt: v.number(),
    recordingStartedAt: v.optional(v.number()),
    recordingStoppedAt: v.optional(v.number()),
    disconnectedAt: v.optional(v.number()),
    leftAt: v.optional(v.number()),
    lastClientSequence: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_livekit_identity", ["sessionId", "livekitIdentity"])
    .index("by_session_connection_state_last_seen", ["sessionId", "connectionState", "lastSeenAt"])
    .index("by_connection_state_last_seen", ["connectionState", "lastSeenAt"])
    .index("by_last_seen", ["lastSeenAt"]),

  scenes: defineTable({
    sessionId: v.id("sessions"),
    revision: v.number(),
    layout: sceneLayout,
    activeParticipantIds: v.array(v.id("participants")),
    cutAtServerMs: v.number(),
    source: sceneSource,
    reason: v.optional(v.string()),
    idempotencyKey: v.string(),
    status: sceneStatus,
    createdAt: v.number(),
    createdByParticipantId: v.optional(v.id("participants")),
  })
    .index("by_session_revision", ["sessionId", "revision"])
    .index("by_session_cut", ["sessionId", "cutAtServerMs"])
    .index("by_session_idempotency", ["sessionId", "idempotencyKey"]),

  bursts: defineTable({
    sessionId: v.id("sessions"),
    anchorServerMs: v.number(),
    windowStartServerMs: v.number(),
    windowEndServerMs: v.number(),
    contributionDeadlineMs: v.number(),
    initiatorParticipantIds: v.array(v.id("participants")),
    expectedParticipantIds: v.array(v.id("participants")),
    markerCount: v.number(),
    readyContributionCount: v.number(),
    acknowledgedContributionCount: v.optional(v.number()),
    status: burstStatus,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session_anchor", ["sessionId", "anchorServerMs"])
    .index("by_session_status", ["sessionId", "status"]),

  burstMarkers: defineTable({
    sessionId: v.id("sessions"),
    burstId: v.id("bursts"),
    participantId: v.id("participants"),
    clientMarkerId: v.string(),
    markerServerMs: v.number(),
    clientObservedAtMs: v.optional(v.number()),
    clockOffsetMs: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_burst", ["burstId"])
    .index("by_participant_client_marker", ["participantId", "clientMarkerId"]),

  burstContributions: defineTable({
    sessionId: v.id("sessions"),
    burstId: v.id("bursts"),
    participantId: v.id("participants"),
    status: contributionStatus,
    preservedStartMs: v.optional(v.number()),
    preservedEndMs: v.optional(v.number()),
    captureSkewMs: v.optional(v.number()),
    assetId: v.optional(v.id("assets")),
    failureReason: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_burst", ["burstId"])
    .index("by_burst_participant", ["burstId", "participantId"])
    .index("by_participant", ["participantId"]),

  assets: defineTable({
    sessionId: v.id("sessions"),
    participantId: v.optional(v.id("participants")),
    burstId: v.optional(v.id("bursts")),
    clientAssetId: v.string(),
    kind: assetKind,
    status: assetStatus,
    storageId: v.optional(v.id("_storage")),
    externalUrl: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    byteLength: v.optional(v.number()),
    sha256: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    startsAtServerMs: v.optional(v.number()),
    endsAtServerMs: v.optional(v.number()),
    failureReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_participant_client_asset", ["participantId", "clientAssetId"])
    .index("by_burst", ["burstId"]),

  renderJobs: defineTable({
    sessionId: v.id("sessions"),
    burstId: v.id("bursts"),
    ownerParticipantId: v.id("participants"),
    requestedByMarkerId: v.id("burstMarkers"),
    idempotencyKey: v.string(),
    provider: v.literal("shotstack"),
    status: renderStatus,
    recipeVersion: v.optional(v.number()),
    recipeJson: v.optional(v.string()),
    inputAssetIds: v.array(v.id("assets")),
    providerJobId: v.optional(v.string()),
    outputAssetId: v.optional(v.id("assets")),
    attempt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerParticipantId"])
    .index("by_burst", ["burstId"])
    .index("by_idempotency", ["idempotencyKey"])
    .index("by_provider_job", ["providerJobId"]),

  renderEvents: defineTable({
    renderJobId: v.id("renderJobs"),
    providerEventId: v.string(),
    providerStatus: v.string(),
    receivedAt: v.number(),
  })
    .index("by_provider_event", ["providerEventId"])
    .index("by_render_job", ["renderJobId"]),
});
