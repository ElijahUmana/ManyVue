import { ConvexHttpClient } from "convex/browser";
import { SignJWT } from "jose";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { runtimeValue } from "@/lib/runtime/environment";

export const runtime = "edge";

type TokenRequest = {
  role?: "program" | "camera";
  sessionSlug?: string;
  sessionId?: string;
  participantId?: string;
  participantCapability?: string;
  hostCapability?: string;
};

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

export async function POST(request: Request) {
  const livekitUrl = runtimeValue("LIVEKIT_URL") || runtimeValue("NEXT_PUBLIC_LIVEKIT_URL");
  const apiKey = runtimeValue("LIVEKIT_API_KEY");
  const apiSecret = runtimeValue("LIVEKIT_API_SECRET");
  const convexUrl = runtimeValue("CONVEX_URL") || runtimeValue("NEXT_PUBLIC_CONVEX_URL");

  if (!livekitUrl || !apiKey || !apiSecret || !convexUrl) {
    return Response.json(
      {
        configured: false,
        error: "Live media transport is not fully configured.",
        missing: [
          !livekitUrl && "LIVEKIT_URL",
          !apiKey && "LIVEKIT_API_KEY",
          !apiSecret && "LIVEKIT_API_SECRET",
          !convexUrl && "CONVEX_URL",
        ].filter(Boolean),
      },
      { status: 503 },
    );
  }

  try {
    const body = await request.json() as TokenRequest;
    const role = body.role === "program" ? "program" : body.role === "camera" ? "camera" : null;
    if (!role) return Response.json({ configured: true, error: "A valid media role is required." }, { status: 400 });

    const participantId = required(body.participantId, "participantId") as Id<"participants">;
    const participantCapability = required(body.participantCapability, "participantCapability");
    const convex = new ConvexHttpClient(convexUrl);
    const authorized = role === "program"
      ? await convex.query(api.sessions.authorizeProgramMedia, {
          sessionId: required(body.sessionId, "sessionId") as Id<"sessions">,
          hostCapability: required(body.hostCapability, "hostCapability"),
          participantId,
          participantCapability,
        })
      : await convex.query(api.participants.authorizeLiveMedia, {
          participantId,
          participantCapability,
          sessionSlug: required(body.sessionSlug, "sessionSlug"),
        });

    const secret = new TextEncoder().encode(apiSecret);
    const token = await new SignJWT({
      name: authorized.displayName,
      metadata: JSON.stringify({ role, participantId }),
      video: {
        roomJoin: true,
        room: authorized.room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(apiKey)
      .setSubject(authorized.identity)
      .setIssuedAt()
      .setNotBefore("-5s")
      .setExpirationTime("2h")
      .sign(secret);

    return Response.json({
      configured: true,
      token,
      url: livekitUrl,
      room: authorized.room,
      identity: authorized.identity,
    });
  } catch (error) {
    console.error("ManyVue media authorization rejected a token request.", error);
    return Response.json(
      { configured: true, error: "This device is not authorized for the requested live room." },
      { status: 403 },
    );
  }
}

export async function GET() {
  return Response.json(
    { configured: true, error: "Live-room credentials are issued only through authenticated POST requests." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
