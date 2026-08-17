import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function createCapabilityToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function createSessionSlug(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `cut-${base64Url(bytes).toLowerCase()}`;
}

export async function hashCapability(token: string): Promise<string> {
  if (token.length < 32 || token.length > 256) {
    throw new ConvexError({ code: "INVALID_CAPABILITY", message: "Invalid capability token." });
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertHost(
  ctx: ReadCtx,
  sessionId: Id<"sessions">,
  hostCapability: string,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.hostCapabilityHash !== (await hashCapability(hostCapability))) {
    throw new ConvexError({ code: "UNAUTHORIZED", message: "Host capability is invalid." });
  }
  return session;
}

export async function assertParticipant(
  ctx: ReadCtx,
  participantId: Id<"participants">,
  participantCapability: string,
): Promise<Doc<"participants">> {
  const participant = await ctx.db.get(participantId);
  if (!participant || participant.capabilityHash !== (await hashCapability(participantCapability))) {
    throw new ConvexError({ code: "UNAUTHORIZED", message: "Participant capability is invalid." });
  }
  return participant;
}

export function publicParticipant(participant: Doc<"participants">) {
  const { capabilityHash: _capabilityHash, ...safe } = participant;
  void _capabilityHash;
  return safe;
}

export function publicSession(session: Doc<"sessions">) {
  const { hostCapabilityHash: _hostCapabilityHash, ...safe } = session;
  void _hostCapabilityHash;
  return safe;
}
