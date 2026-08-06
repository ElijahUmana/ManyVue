import { handleShotstackWebhook } from "@/lib/artifacts/shotstack-webhook";
import { runtimeValue } from "@/lib/runtime/environment";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleShotstackWebhook(request, {
    SHOTSTACK_API_KEY: runtimeValue("SHOTSTACK_API_KEY"),
    SHOTSTACK_API_BASE_URL: runtimeValue("SHOTSTACK_API_BASE_URL"),
    SHOTSTACK_WEBHOOK_TOKEN: runtimeValue("SHOTSTACK_WEBHOOK_TOKEN"),
    CONVEX_RENDER_WEBHOOK_URL: runtimeValue("CONVEX_RENDER_WEBHOOK_URL"),
    CONVEX_RENDER_WEBHOOK_TOKEN: runtimeValue("CONVEX_RENDER_WEBHOOK_TOKEN"),
  });
}
