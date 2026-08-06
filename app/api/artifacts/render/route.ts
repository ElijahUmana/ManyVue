import { queueShotstackRender, validateArtifactRenderRequest } from "@/lib/artifacts/shotstack";
import { runtimeValue } from "@/lib/runtime/environment";

export const dynamic = "force-dynamic";

function env(requestUrl?: string) {
  return {
    SHOTSTACK_API_KEY: runtimeValue("SHOTSTACK_API_KEY"),
    SHOTSTACK_API_BASE_URL: runtimeValue("SHOTSTACK_API_BASE_URL"),
    SHOTSTACK_WEBHOOK_URL: runtimeValue("SHOTSTACK_WEBHOOK_URL") || (requestUrl
      ? new URL("/api/artifacts/shotstack/webhook", requestUrl).toString()
      : undefined),
    SHOTSTACK_WEBHOOK_TOKEN: runtimeValue("SHOTSTACK_WEBHOOK_TOKEN"),
  };
}

export async function GET() {
  const missing = ["SHOTSTACK_API_KEY", "SHOTSTACK_WEBHOOK_TOKEN"].filter((key) => !runtimeValue(key));
  return Response.json({ service: "shotstack-production-renderer", state: missing.length === 0 ? "configured" : "unconfigured", missing });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ state: "invalid_request", errors: ["Request body must be JSON"] }, { status: 400 });
  }
  const validated = validateArtifactRenderRequest(payload);
  if (!validated.ok) return Response.json({ state: "invalid_request", errors: validated.errors }, { status: 400 });
  const result = await queueShotstackRender(validated.value, env(request.url));
  const status = result.state === "queued" ? 202 : result.state === "unconfigured" ? 503 : result.state === "rejected" ? 400 : 502;
  return Response.json(result, { status });
}
