import { handleShotstackWebhook } from "@/lib/artifacts/shotstack-webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleShotstackWebhook(request, {
    SHOTSTACK_API_KEY: process.env.SHOTSTACK_API_KEY,
    SHOTSTACK_API_BASE_URL: process.env.SHOTSTACK_API_BASE_URL,
    SHOTSTACK_WEBHOOK_TOKEN: process.env.SHOTSTACK_WEBHOOK_TOKEN,
    CONVEX_RENDER_WEBHOOK_URL: process.env.CONVEX_RENDER_WEBHOOK_URL,
    CONVEX_RENDER_WEBHOOK_TOKEN: process.env.CONVEX_RENDER_WEBHOOK_TOKEN,
  });
}

