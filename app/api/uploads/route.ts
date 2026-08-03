import { env } from "cloudflare:workers";

export const runtime = "edge";

type UploadEnv = { MEDIA?: R2Bucket };

// The deployed Sites ingress rejects multipart bodies around 2 MiB before the
// Worker executes. Keep a small explicit margin so clients receive a stable
// application error whenever the request reaches us.
const MAX_MEDIA_BYTES = 1_800_000;
const ALLOWED_UPLOAD_KINDS = new Set([
  "original",
  "master-audio",
  "burst-source",
  "burst-contact-sheet",
  "thumbnail",
]);

function bucket() {
  return (env as unknown as UploadEnv).MEDIA;
}

function safePart(value: FormDataEntryValue | null, fallback: string) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

function assetUrl(origin: string, key: string) {
  return `${origin}/api/uploads?key=${encodeURIComponent(key)}`;
}

export async function POST(request: Request) {
  const media = bucket();
  if (!media) {
    return Response.json({ ok: false, error: "MEDIA object storage is unavailable." }, { status: 503 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ ok: false, error: "A non-empty media file is required." }, { status: 400 });
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return Response.json({ ok: false, error: "Burst media must stay below 1.8 MB; use the rolling low-bitrate capture profile." }, { status: 413 });
  }

  const session = safePart(form.get("session"), "session");
  const participant = safePart(form.get("participant"), "participant");
  const kind = safePart(form.get("kind"), "clip");
  if (!ALLOWED_UPLOAD_KINDS.has(kind)) {
    return Response.json({ ok: false, error: "Unsupported CrowdCut media kind." }, { status: 400 });
  }
  const clientAssetId = form.has("clientAssetId")
    ? safePart(form.get("clientAssetId"), "asset")
    : null;
  const extension = file.type.includes("mp4") ? "mp4"
    : file.type.includes("jpeg") ? "jpg"
      : file.type.includes("png") ? "png"
        : file.type.includes("mpeg") ? "mp3"
          : file.type.includes("wav") ? "wav"
            : file.type.includes("aac") || file.type.includes("m4a") ? "m4a"
              : "webm";
  // A deterministic client asset ID turns network retries into an idempotent
  // lookup rather than duplicate Burst sources in the edit candidate set.
  const key = clientAssetId
    ? `${session}/${participant}/${kind}-${clientAssetId}.${extension}`
    : `${session}/${participant}/${Date.now()}-${kind}-${crypto.randomUUID()}.${extension}`;
  const origin = new URL(request.url).origin;
  if (clientAssetId) {
    const existing = await media.head(key);
    if (existing) {
      return Response.json({ ok: true, duplicate: true, key, url: assetUrl(origin, key) });
    }
  }

  await media.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: {
      session,
      participant,
      kind,
      burstId: safePart(form.get("burstId"), "none"),
      durationMs: safePart(form.get("durationMs"), "0"),
      burstOffsetMs: safePart(form.get("burstOffsetMs"), "0"),
      ...(clientAssetId ? { clientAssetId } : {}),
    },
  });

  return Response.json({ ok: true, duplicate: false, key, url: assetUrl(origin, key) });
}

export async function GET(request: Request) {
  const media = bucket();
  if (!media) return new Response("Media storage unavailable", { status: 503 });
  const url = new URL(request.url);
  const listSession = url.searchParams.get("session");
  if (url.searchParams.get("list") === "1" && listSession) {
    const session = listSession.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    const participantFilter = url.searchParams.has("participant")
      ? safePart(url.searchParams.get("participant"), "participant")
      : null;
    const burstFilter = url.searchParams.has("burstId")
      ? safePart(url.searchParams.get("burstId"), "none")
      : null;
    const kindFilter = url.searchParams.has("kind")
      ? safePart(url.searchParams.get("kind"), "clip")
      : null;
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const page = await media.list({
        prefix: participantFilter ? `${session}/${participantFilter}/` : `${session}/`,
        cursor,
      });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const assets = (await Promise.all(objects.map(async (object) => {
      const head = await media.head(object.key);
      const metadata = head?.customMetadata || object.customMetadata || {};
      if (burstFilter && metadata.burstId !== burstFilter) return null;
      if (kindFilter && metadata.kind !== kindFilter) return null;
      return {
        key: object.key,
        url: assetUrl(url.origin, object.key),
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        contentType: object.httpMetadata?.contentType || head?.httpMetadata?.contentType || null,
        metadata,
      };
    }))).filter((asset): asset is NonNullable<typeof asset> => asset !== null)
      .sort((left, right) => left.uploaded.localeCompare(right.uploaded));
    return Response.json({
      ok: true,
      assets,
    });
  }
  const key = url.searchParams.get("key");
  if (!key || key.includes("..")) return new Response("Invalid key", { status: 400 });
  const object = await media.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
}
