import { env } from "cloudflare:workers";

export const runtime = "edge";

type UploadEnv = { MEDIA?: R2Bucket };

function bucket() {
  return (env as unknown as UploadEnv).MEDIA;
}

function safePart(value: FormDataEntryValue | null, fallback: string) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
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

  const session = safePart(form.get("session"), "session");
  const participant = safePart(form.get("participant"), "participant");
  const kind = safePart(form.get("kind"), "clip");
  const extension = file.type.includes("mp4") ? "mp4"
    : file.type.includes("jpeg") ? "jpg"
      : file.type.includes("png") ? "png"
        : file.type.includes("mpeg") ? "mp3"
          : file.type.includes("wav") ? "wav"
            : file.type.includes("aac") || file.type.includes("m4a") ? "m4a"
              : "webm";
  const key = `${session}/${participant}/${Date.now()}-${kind}-${crypto.randomUUID()}.${extension}`;

  await media.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: {
      session,
      participant,
      kind,
      durationMs: safePart(form.get("durationMs"), "0"),
      burstOffsetMs: safePart(form.get("burstOffsetMs"), "0"),
    },
  });

  const origin = new URL(request.url).origin;
  return Response.json({ ok: true, key, url: `${origin}/api/uploads?key=${encodeURIComponent(key)}` });
}

export async function GET(request: Request) {
  const media = bucket();
  if (!media) return new Response("Media storage unavailable", { status: 503 });
  const url = new URL(request.url);
  const listSession = url.searchParams.get("session");
  if (url.searchParams.get("list") === "1" && listSession) {
    const session = listSession.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    const result = await media.list({ prefix: `${session}/` });
    const assets = await Promise.all(result.objects.map(async (object) => {
      const head = await media.head(object.key);
      return {
        key: object.key,
        url: `${url.origin}/api/uploads?key=${encodeURIComponent(object.key)}`,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        contentType: head?.httpMetadata?.contentType || object.httpMetadata?.contentType || null,
        metadata: head?.customMetadata || object.customMetadata || {},
      };
    }));
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
