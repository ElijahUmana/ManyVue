import {
  validateEditRecipe,
  validateEditRecipeInput,
  type EditCandidate,
  type EditRecipe,
  type EditRecipeInput,
  type ValidationResult,
} from "../ai/edit-recipe";

const PRODUCTION_BASE_URL = "https://api.shotstack.io/edit/v1";

export interface ArtifactRenderRequest {
  editInput: EditRecipeInput;
  recipe: EditRecipe;
  masterAudioUrl: string;
}

export interface ShotstackEnv {
  SHOTSTACK_API_KEY?: string;
  SHOTSTACK_API_BASE_URL?: string;
  SHOTSTACK_WEBHOOK_URL?: string;
  SHOTSTACK_WEBHOOK_TOKEN?: string;
}

export interface ShotstackRenderStatus {
  id: string;
  status: string;
  url: string | null;
  error: string | null;
  completedAt: string | null;
}

export type QueueRenderResult =
  | { state: "queued"; renderId: string; artifactId: string; provider: "shotstack-production" }
  | { state: "unconfigured"; missing: string[]; reason: string }
  | { state: "rejected"; reason: string }
  | { state: "error"; reason: string; status: number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeProductionBaseUrl(env: ShotstackEnv): string | null {
  const base = (env.SHOTSTACK_API_BASE_URL?.trim() || PRODUCTION_BASE_URL).replace(/\/+$/, "");
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.hostname !== "api.shotstack.io") return null;
    if (!url.pathname.endsWith("/edit/v1")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function validateArtifactRenderRequest(value: unknown): ValidationResult<ArtifactRenderRequest> {
  if (!isRecord(value)) return { ok: false, errors: ["render request must be an object"] };
  const allowed = new Set(["editInput", "recipe", "masterAudioUrl"]);
  const errors = Object.keys(value).every((key) => allowed.has(key)) ? [] : ["render request contains unsupported properties"];
  const editInput = validateEditRecipeInput(value.editInput);
  if (!editInput.ok) errors.push(...editInput.errors.map((error) => `editInput: ${error}`));
  if (!isHttpsUrl(value.masterAudioUrl)) errors.push("masterAudioUrl must be a real HTTPS asset URL");
  if (!editInput.ok) return { ok: false, errors };
  const recipe = validateEditRecipe(value.recipe, editInput.value);
  if (!recipe.ok) errors.push(...recipe.errors.map((error) => `recipe: ${error}`));
  if (!recipe.ok || !isHttpsUrl(value.masterAudioUrl) || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { editInput: editInput.value, recipe: recipe.value, masterAudioUrl: value.masterAudioUrl } };
}

function callbackWithToken(callbackUrl: string, token: string): string {
  const url = new URL(callbackUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function transitionForShotstack(transition: EditRecipe["shots"][number]["transition"]): string | null {
  if (transition === "cut") return null;
  return transition;
}

function compactCrop(crop: EditRecipe["shots"][number]["crop"]): Record<string, number> | undefined {
  const entries = Object.entries(crop).filter(([, value]) => value > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function candidateMap(candidates: EditCandidate[]): Map<string, EditCandidate> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

export function buildShotstackEdit(request: ArtifactRenderRequest, callbackUrl: string): Record<string, unknown> {
  const sources = candidateMap(request.editInput.candidates);
  const clips = request.recipe.shots.map((shot) => {
    const source = sources.get(shot.sourceId);
    if (!source) throw new Error(`Missing real source ${shot.sourceId}`);
    const transition = transitionForShotstack(shot.transition);
    const crop = compactCrop(shot.crop);
    return {
      asset: {
        type: "video",
        src: source.clipUrl,
        trim: shot.sourceInMs / 1_000,
        volume: shot.sourceVolume,
        transcode: true,
        ...(crop ? { crop } : {}),
      },
      start: shot.startMs / 1_000,
      length: shot.durationMs / 1_000,
      fit: "crop",
      ...(transition ? { transition: { in: transition } } : {}),
      alias: `SOURCE_${shot.sourceId.replace(/[^A-Za-z0-9_]/g, "_")}`,
    };
  });

  return {
    timeline: {
      soundtrack: {
        src: request.masterAudioUrl,
        effect: "fadeInFadeOut",
        volume: request.recipe.audio.masterVolume,
      },
      background: "#050507",
      tracks: [{ clips }],
      cache: true,
    },
    output: {
      format: "mp4",
      resolution: "hd",
      aspectRatio: "9:16",
      fps: 30,
      quality: "high",
      mute: false,
      range: { start: 0, length: request.recipe.durationMs / 1_000 },
      destinations: [{ provider: "shotstack", exclude: false }],
    },
    callback: callbackUrl,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function configuration(env: ShotstackEnv):
  | { ok: true; apiKey: string; baseUrl: string; callbackUrl: string }
  | { ok: false; missing: string[]; reason: string } {
  const missing: string[] = [];
  if (!env.SHOTSTACK_API_KEY?.trim()) missing.push("SHOTSTACK_API_KEY");
  if (!env.SHOTSTACK_WEBHOOK_URL?.trim()) missing.push("SHOTSTACK_WEBHOOK_URL");
  if (!env.SHOTSTACK_WEBHOOK_TOKEN?.trim()) missing.push("SHOTSTACK_WEBHOOK_TOKEN");
  const baseUrl = normalizeProductionBaseUrl(env);
  if (!baseUrl) missing.push("SHOTSTACK_API_BASE_URL(production /edit/v1 required)");
  if (missing.length > 0) {
    return { ok: false, missing, reason: "Shotstack production rendering is not fully configured; no render was queued." };
  }
  let callbackUrl: string;
  try {
    callbackUrl = callbackWithToken(env.SHOTSTACK_WEBHOOK_URL as string, env.SHOTSTACK_WEBHOOK_TOKEN as string);
    if (!callbackUrl.startsWith("https://")) throw new Error("not HTTPS");
  } catch {
    return { ok: false, missing: ["SHOTSTACK_WEBHOOK_URL(valid HTTPS URL required)"], reason: "Shotstack webhook URL is invalid; no render was queued." };
  }
  return { ok: true, apiKey: env.SHOTSTACK_API_KEY as string, baseUrl: baseUrl as string, callbackUrl };
}

export async function queueShotstackRender(request: ArtifactRenderRequest, env: ShotstackEnv): Promise<QueueRenderResult> {
  const config = configuration(env);
  if (!config.ok) return { state: "unconfigured", missing: config.missing, reason: config.reason };
  try {
    const response = await fetchWithTimeout(`${config.baseUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify(buildShotstackEdit(request, config.callbackUrl)),
    });
    const bodyText = await response.text();
    if (!response.ok) return { state: "error", reason: `Shotstack rejected the render (${response.status}): ${bodyText.slice(0, 900)}`, status: response.status };
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return { state: "error", reason: "Shotstack returned a non-JSON queue response.", status: response.status };
    }
    const renderId = isRecord(body) && isRecord(body.response) && typeof body.response.id === "string" ? body.response.id : null;
    if (!renderId) return { state: "error", reason: "Shotstack accepted the request without returning a render ID.", status: response.status };
    return { state: "queued", renderId, artifactId: request.editInput.artifactId, provider: "shotstack-production" };
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : "Unknown Shotstack queue failure", status: null };
  }
}

export function normalizeShotstackRenderStatus(payload: unknown): ShotstackRenderStatus | null {
  if (!isRecord(payload)) return null;
  const record = isRecord(payload.response) ? payload.response : payload;
  const id = typeof record.id === "string" ? record.id : null;
  const status = typeof record.status === "string" ? record.status : null;
  if (!id || !status) return null;
  return {
    id,
    status,
    url: typeof record.url === "string" ? record.url : null,
    error: typeof record.error === "string" ? record.error : null,
    completedAt: typeof record.completed === "string" ? record.completed : null,
  };
}

export async function getShotstackRenderStatus(
  renderId: string,
  env: Pick<ShotstackEnv, "SHOTSTACK_API_KEY" | "SHOTSTACK_API_BASE_URL">,
  options: { timeoutMs?: number } = {},
): Promise<{ state: "verified"; render: ShotstackRenderStatus } | { state: "unconfigured" | "error"; reason: string }> {
  const apiKey = env.SHOTSTACK_API_KEY?.trim();
  const baseUrl = normalizeProductionBaseUrl(env);
  if (!apiKey || !baseUrl) return { state: "unconfigured", reason: "Shotstack production status verification is not configured." };
  if (!/^[A-Za-z0-9-]{8,128}$/.test(renderId)) return { state: "error", reason: "Invalid Shotstack render ID." };
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/render/${encodeURIComponent(renderId)}`,
      { headers: { Accept: "application/json", "x-api-key": apiKey } },
      options.timeoutMs ?? 8_000,
    );
    if (!response.ok) return { state: "error", reason: `Shotstack status verification returned HTTP ${response.status}.` };
    const normalized = normalizeShotstackRenderStatus(await response.json());
    if (!normalized) return { state: "error", reason: "Shotstack status response was malformed." };
    return { state: "verified", render: normalized };
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : "Unknown Shotstack status failure" };
  }
}
