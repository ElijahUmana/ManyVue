import { env } from "cloudflare:workers";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { runtimeValue } from "@/lib/runtime/environment";
import { signedMediaUrl, verifyMediaKey } from "@/lib/security/media-url";

export const runtime = "edge";

type UploadEnv = { MEDIA?: R2Bucket };

// Sites ingress rejects large multipart bodies before the Worker executes.
// Rolling Burst sources deliberately retain headroom below this boundary.
const MAX_MEDIA_BYTES = 1_800_000;
const ALLOWED_UPLOAD_KINDS = new Set(["burst-source", "thumbnail"]);

function bucket() {
  return (env as unknown as UploadEnv).MEDIA;
}

function safePart(value: FormDataEntryValue | string | null, fallback: string) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function authorizationClient() {
  const convexUrl = runtimeValue("CONVEX_URL") || runtimeValue("NEXT_PUBLIC_CONVEX_URL");
  if (!convexUrl) throw new Error("Convex media authorization is unavailable.");
  return new ConvexHttpClient(convexUrl);
}

function signingSecret() {
  const secret = runtimeValue("MEDIA_SIGNING_SECRET");
  if (!secret || secret.length < 32) throw new Error("MEDIA_SIGNING_SECRET is not configured.");
  return secret;
}

async function authorizeParticipant(request: Request) {
  const participantId = requiredHeader(request, "x-manyvue-participant-id");
  const participantCapability = requiredHeader(request, "x-manyvue-participant-capability");
  const burstId = requiredHeader(request, "x-manyvue-burst-id");
  const sessionSlug = requiredHeader(request, "x-manyvue-session-slug");
  const authorization = await authorizationClient().query(api.bursts.authorizeParticipantMedia, {
    participantId: participantId as Id<"participants">,
    participantCapability,
    burstId: burstId as Id<"bursts">,
    sessionSlug,
  });
  return { participantId, participantCapability, burstId, sessionSlug, ...authorization };
}

async function authorizeHostContribution(request: Request) {
  const sessionId = requiredHeader(request, "x-manyvue-session-id");
  const hostCapability = requiredHeader(request, "x-manyvue-host-capability");
  const participantId = requiredHeader(request, "x-manyvue-participant-id");
  const burstId = requiredHeader(request, "x-manyvue-burst-id");
  const sessionSlug = requiredHeader(request, "x-manyvue-session-slug");
  const authorization = await authorizationClient().query(api.bursts.authorizeHostContributionMedia, {
    sessionId: sessionId as Id<"sessions">,
    hostCapability,
    participantId: participantId as Id<"participants">,
    burstId: burstId as Id<"bursts">,
    sessionSlug,
  });
  return authorization;
}

async function authorizeUpload(request: Request) {
  return request.headers.get("x-manyvue-media-role") === "host"
    ? await authorizeHostContribution(request)
    : await authorizeParticipant(request);
}

async function authorizeListing(request: Request, sessionSlug: string, burstId: string) {
  const role = request.headers.get("x-manyvue-media-role");
  if (role === "host") {
    return await authorizationClient().query(api.bursts.authorizeHostMedia, {
      sessionId: requiredHeader(request, "x-manyvue-session-id") as Id<"sessions">,
      hostCapability: requiredHeader(request, "x-manyvue-host-capability"),
      burstId: burstId as Id<"bursts">,
      sessionSlug,
    });
  }
  const authorization = await authorizeParticipant(request);
  if (authorization.sessionSlug !== sessionSlug || authorization.burstId !== burstId) {
    throw new Error("Burst listing does not match its participant authorization.");
  }
  return authorization;
}

function extensionFor(file: File) {
  return file.type.includes("mp4") ? "mp4"
    : file.type.includes("jpeg") ? "jpg"
      : file.type.includes("png") ? "png"
        : "webm";
}

export async function POST(request: Request) {
  const media = bucket();
  if (!media) {
    return Response.json({ ok: false, error: "MEDIA object storage is unavailable." }, { status: 503 });
  }

  let authorized: Awaited<ReturnType<typeof authorizeUpload>>;
  try {
    authorized = await authorizeUpload(request);
    if (!authorized.canWrite) throw new Error("Camera is not an expected Burst contributor.");
  } catch (error) {
    console.error("ManyVue rejected an unauthorized media upload.", error);
    return Response.json({ ok: false, error: "This camera is not authorized to upload this Burst." }, { status: 403 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ ok: false, error: "A non-empty media file is required." }, { status: 400 });
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return Response.json({ ok: false, error: "Burst media must stay below 1.8 MB; use the rolling capture profile." }, { status: 413 });
  }

  const rawSession = String(form.get("session") || "");
  const rawParticipant = String(form.get("participant") || "");
  const rawBurstId = String(form.get("burstId") || "");
  if (
    rawSession !== authorized.sessionSlug ||
    rawParticipant !== authorized.participantId ||
    rawBurstId !== authorized.burstId
  ) {
    return Response.json({ ok: false, error: "Upload identity does not match its authorization." }, { status: 403 });
  }

  const session = safePart(rawSession, "session");
  const participant = safePart(rawParticipant, "participant");
  const kind = safePart(form.get("kind"), "clip");
  if (!ALLOWED_UPLOAD_KINDS.has(kind)) {
    return Response.json({ ok: false, error: "Unsupported ManyVue media kind." }, { status: 400 });
  }
  const clientAssetId = form.has("clientAssetId")
    ? safePart(form.get("clientAssetId"), "asset")
    : null;
  if (!clientAssetId) {
    return Response.json({ ok: false, error: "An idempotent client asset ID is required." }, { status: 400 });
  }

  const key = `${session}/${participant}/${kind}-${clientAssetId}.${extensionFor(file)}`;
  const origin = new URL(request.url).origin;
  const secret = signingSecret();
  const existing = await media.head(key);
  if (existing) {
    return Response.json({
      ok: true,
      duplicate: true,
      key,
      url: await signedMediaUrl(origin, key, secret),
    });
  }

  await media.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: {
      session,
      participant,
      kind,
      burstId: safePart(rawBurstId, "none"),
      durationMs: safePart(form.get("durationMs"), "0"),
      burstOffsetMs: safePart(form.get("burstOffsetMs"), "0"),
      clientAssetId,
    },
  });

  return Response.json({
    ok: true,
    duplicate: false,
    key,
    url: await signedMediaUrl(origin, key, secret),
  });
}

export async function GET(request: Request) {
  const media = bucket();
  if (!media) return new Response("Media storage unavailable", { status: 503 });
  const url = new URL(request.url);
  const listSession = url.searchParams.get("session");
  if (url.searchParams.get("list") === "1" && listSession) {
    const rawBurstId = url.searchParams.get("burstId");
    if (!rawBurstId) return Response.json({ ok: false, error: "Burst ID is required." }, { status: 400 });
    try {
      await authorizeListing(request, listSession, rawBurstId);
    } catch (error) {
      console.error("ManyVue rejected an unauthorized Burst listing.", error);
      return Response.json({ ok: false, error: "This device is not authorized to view this Burst." }, { status: 403 });
    }

    const session = safePart(listSession, "session");
    const burstFilter = safePart(rawBurstId, "none");
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const page = await media.list({ prefix: `${session}/`, cursor });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const secret = signingSecret();
    const assets = (await Promise.all(objects.map(async (object) => {
      const head = await media.head(object.key);
      const metadata = head?.customMetadata || object.customMetadata || {};
      if (metadata.burstId !== burstFilter) return null;
      return {
        key: object.key,
        url: await signedMediaUrl(url.origin, object.key, secret),
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        contentType: object.httpMetadata?.contentType || head?.httpMetadata?.contentType || null,
        metadata,
      };
    }))).filter((asset): asset is NonNullable<typeof asset> => asset !== null)
      .sort((left, right) => left.uploaded.localeCompare(right.uploaded));
    return Response.json({ ok: true, assets }, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  const key = url.searchParams.get("key");
  const expiresAt = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") || "";
  if (!key || key.includes("..")) return new Response("Invalid key", { status: 400 });
  let secret: string;
  try {
    secret = signingSecret();
  } catch (error) {
    console.error("ManyVue media signing is unavailable.", error);
    return new Response("Media signing unavailable", { status: 503 });
  }
  if (!await verifyMediaKey(key, expiresAt, signature, secret)) {
    return new Response("Media link is invalid or expired", { status: 403 });
  }
  const object = await media.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}
