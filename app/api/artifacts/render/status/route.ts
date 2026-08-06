import { getShotstackRenderStatus } from "@/lib/artifacts/shotstack";
import { runtimeValue } from "@/lib/runtime/environment";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const renderId = new URL(request.url).searchParams.get("id");
  if (!renderId) return Response.json({ state: "invalid_request", reason: "id is required" }, { status: 400 });
  const result = await getShotstackRenderStatus(renderId, {
    SHOTSTACK_API_KEY: runtimeValue("SHOTSTACK_API_KEY"),
    SHOTSTACK_API_BASE_URL: runtimeValue("SHOTSTACK_API_BASE_URL"),
  });
  return Response.json(result, { status: result.state === "verified" ? 200 : result.state === "unconfigured" ? 503 : 502 });
}
