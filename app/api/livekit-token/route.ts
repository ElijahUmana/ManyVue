import { SignJWT } from "jose";

export const runtime = "edge";

const safe = (value: string | null, fallback: string) =>
  (value || fallback).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const livekitUrl = process.env.LIVEKIT_URL || process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!livekitUrl || !apiKey || !apiSecret) {
    return Response.json(
      {
        configured: false,
        error: "Live media transport is not configured.",
        missing: [
          !livekitUrl && "LIVEKIT_URL",
          !apiKey && "LIVEKIT_API_KEY",
          !apiSecret && "LIVEKIT_API_SECRET",
        ].filter(Boolean),
      },
      { status: 503 },
    );
  }

  const room = safe(url.searchParams.get("session"), "outside-live");
  const identity = safe(url.searchParams.get("participant"), crypto.randomUUID());
  const role = safe(url.searchParams.get("role"), "camera");
  const name = (url.searchParams.get("name") || (role === "program" ? "Program" : "Crowd Camera")).slice(0, 80);
  const secret = new TextEncoder().encode(apiSecret);

  const token = await new SignJWT({
    name,
    metadata: JSON.stringify({ role }),
    video: {
      roomJoin: true,
      room,
      canPublish: role !== "viewer",
      canSubscribe: true,
      canPublishData: true,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(apiKey)
    .setSubject(identity)
    .setIssuedAt()
    .setNotBefore("-5s")
    .setExpirationTime("2h")
    .sign(secret);

  return Response.json({ configured: true, token, url: livekitUrl, room, identity });
}
