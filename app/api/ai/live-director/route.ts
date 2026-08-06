import { directLiveCameras, validateLiveDirectorCameras } from "@/lib/ai/live-director";
import { runtimeValue } from "@/lib/runtime/environment";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    service: "openai-live-vision-director",
    state: runtimeValue("OPENAI_API_KEY") ? "configured" : "unconfigured",
    model: runtimeValue("OPENAI_MODEL") || "gpt-5.6-sol",
  });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ state: "invalid_request", error: "Request body must be JSON." }, { status: 400 });
  }
  const cameras = validateLiveDirectorCameras(payload && typeof payload === "object" ? (payload as { cameras?: unknown }).cameras : null);
  if (!cameras) return Response.json({ state: "invalid_request", error: "One to four valid live camera frames are required." }, { status: 400 });
  return Response.json(await directLiveCameras(cameras, {
    OPENAI_API_KEY: runtimeValue("OPENAI_API_KEY"),
    OPENAI_MODEL: runtimeValue("OPENAI_MODEL"),
  }));
}
