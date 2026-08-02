import { getShotstackRenderStatus, type ShotstackEnv, type ShotstackRenderStatus } from "./shotstack";

export interface ShotstackWebhookEvent {
  type: "edit";
  action: "render";
  id: string;
  status: string;
  url: string | null;
  error: string | null;
  completed: string | null;
}

export interface RenderWebhookEnv extends ShotstackEnv {
  CONVEX_RENDER_WEBHOOK_URL?: string;
  CONVEX_RENDER_WEBHOOK_TOKEN?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseShotstackWebhookEvent(value: unknown): { ok: true; event: ShotstackWebhookEvent } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "Webhook body must be an object." };
  if (value.type !== "edit" || value.action !== "render") return { ok: false, reason: "Webhook is not an edit render event." };
  if (typeof value.id !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(value.id)) return { ok: false, reason: "Webhook render ID is invalid." };
  if (typeof value.status !== "string" || value.status.length > 64) return { ok: false, reason: "Webhook status is invalid." };
  return {
    ok: true,
    event: {
      type: "edit",
      action: "render",
      id: value.id,
      status: value.status,
      url: typeof value.url === "string" ? value.url : null,
      error: typeof value.error === "string" ? value.error : null,
      completed: typeof value.completed === "string" ? value.completed : null,
    },
  };
}

export function constantTimeTokenEqual(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < received.length; index += 1) difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

export function renderEventIdempotencyKey(render: Pick<ShotstackRenderStatus, "id" | "status" | "completedAt">): string {
  return `shotstack:${render.id}:${render.status}:${render.completedAt ?? "pending"}`;
}

function statusMatches(webhook: ShotstackWebhookEvent, verified: ShotstackRenderStatus): boolean {
  if (webhook.id !== verified.id || webhook.status !== verified.status) return false;
  if (webhook.url && verified.url && webhook.url !== verified.url) return false;
  return true;
}

async function forwardToConvex(render: ShotstackRenderStatus, env: RenderWebhookEnv): Promise<{ ok: true } | { ok: false; state: "unconfigured" | "error"; reason: string }> {
  const url = env.CONVEX_RENDER_WEBHOOK_URL?.trim();
  const token = env.CONVEX_RENDER_WEBHOOK_TOKEN?.trim();
  if (!url || !token) return { ok: false, state: "unconfigured", reason: "CONVEX_RENDER_WEBHOOK_URL and CONVEX_RENDER_WEBHOOK_TOKEN are required; event was verified but not acknowledged." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Convex webhook must be HTTPS");
    const response = await fetch(parsed.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": renderEventIdempotencyKey(render),
      },
      body: JSON.stringify({
        provider: "shotstack",
        renderId: render.id,
        status: render.status,
        url: render.url,
        error: render.error,
        completedAt: render.completedAt,
        idempotencyKey: renderEventIdempotencyKey(render),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, state: "error", reason: `Convex render webhook returned HTTP ${response.status}.` };
    return { ok: true };
  } catch (error) {
    return { ok: false, state: "error", reason: error instanceof Error ? error.message : "Unknown Convex forwarding error" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleShotstackWebhook(request: Request, env: RenderWebhookEnv): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!constantTimeTokenEqual(token, env.SHOTSTACK_WEBHOOK_TOKEN)) {
    return Response.json({ state: "unauthorized", reason: "Invalid webhook token." }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ state: "invalid_webhook", reason: "Webhook body must be JSON." }, { status: 400 });
  }
  const parsed = parseShotstackWebhookEvent(payload);
  if (!parsed.ok) return Response.json({ state: "invalid_webhook", reason: parsed.reason }, { status: 400 });

  // Shotstack does not sign edit callbacks. Verify the claimed render through the
  // authenticated production API before changing application state.
  const verification = await getShotstackRenderStatus(parsed.event.id, env, { timeoutMs: 4_500 });
  if (verification.state !== "verified") {
    return Response.json({ state: verification.state, reason: verification.reason }, { status: verification.state === "unconfigured" ? 503 : 502 });
  }
  if (!statusMatches(parsed.event, verification.render)) {
    return Response.json({ state: "verification_failed", reason: "Webhook payload does not match Shotstack's authenticated render status." }, { status: 409 });
  }

  const forwarded = await forwardToConvex(verification.render, env);
  if (!forwarded.ok) return Response.json({ state: forwarded.state, reason: forwarded.reason }, { status: forwarded.state === "unconfigured" ? 503 : 502 });
  return Response.json({ state: "processed", renderId: verification.render.id, idempotencyKey: renderEventIdempotencyKey(verification.render) });
}
