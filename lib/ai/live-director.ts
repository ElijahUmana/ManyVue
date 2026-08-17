const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-sol";

export type CameraZone = "LEFT" | "CENTER" | "RIGHT" | "CROWD";

export type LiveDirectorCamera = {
  id: string;
  label: string;
  zone: CameraZone;
  imageDataUrl: string;
};

export type LiveDirectorDecision = {
  layout: "hero" | "duo";
  activeIds: string[];
  headline: string;
  reason: string;
};

export type LiveDirectorResult = {
  state: "generated" | "deterministic";
  provider: "openai" | "deterministic";
  model: string | null;
  decision: LiveDirectorDecision;
  reason?: string;
};

type LiveDirectorEnv = { OPENAI_API_KEY?: string; OPENAI_MODEL?: string };

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["layout", "activeIds", "headline", "reason"],
  properties: {
    layout: { type: "string", enum: ["hero", "duo"] },
    activeIds: { type: "array", minItems: 1, maxItems: 2, items: { type: "string" } },
    headline: { type: "string", minLength: 3, maxLength: 42 },
    reason: { type: "string", minLength: 8, maxLength: 140 },
  },
} as const;

function fallbackDecision(cameras: LiveDirectorCamera[]): LiveDirectorDecision {
  const center = cameras.find((camera) => camera.zone === "CENTER");
  const left = cameras.find((camera) => camera.zone === "LEFT");
  const right = cameras.find((camera) => camera.zone === "RIGHT");
  if (left && right) {
    return {
      layout: "duo",
      activeIds: [left.id, right.id],
      headline: "AUTO · STAGE CROSS",
      reason: "Paired opposite stage perspectives for immediate spatial contrast.",
    };
  }
  const hero = center || left || right || cameras[0];
  return {
    layout: "hero",
    activeIds: hero ? [hero.id] : [],
    headline: hero ? `AUTO · TAKE ${hero.zone}` : "AUTO · WAITING",
    reason: hero ? "Selected the clearest deterministic stage-relative perspective." : "Waiting for a live camera.",
  };
}

function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const content = item && typeof item === "object" ? (item as { content?: unknown }).content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "output_text" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

function validateDecision(value: unknown, cameras: LiveDirectorCamera[]): LiveDirectorDecision | null {
  if (!value || typeof value !== "object") return null;
  const decision = value as Partial<LiveDirectorDecision>;
  if (decision.layout !== "hero" && decision.layout !== "duo") return null;
  if (!Array.isArray(decision.activeIds) || decision.activeIds.length < 1 || decision.activeIds.length > 2) return null;
  const available = new Set(cameras.map((camera) => camera.id));
  const activeIds = [...new Set(decision.activeIds.filter((id): id is string => typeof id === "string" && available.has(id)))];
  if (activeIds.length !== decision.activeIds.length) return null;
  if (decision.layout === "hero" && activeIds.length !== 1) return null;
  if (decision.layout === "duo" && activeIds.length !== 2) return null;
  if (typeof decision.headline !== "string" || typeof decision.reason !== "string") return null;
  return { layout: decision.layout, activeIds, headline: decision.headline.slice(0, 42), reason: decision.reason.slice(0, 140) };
}

export function validateLiveDirectorCameras(value: unknown): LiveDirectorCamera[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const seen = new Set<string>();
  const cameras: LiveDirectorCamera[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Partial<LiveDirectorCamera>;
    if (typeof candidate.id !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(candidate.id) || seen.has(candidate.id)) return null;
    if (typeof candidate.label !== "string" || candidate.label.length < 1 || candidate.label.length > 80) return null;
    if (!candidate.zone || !["LEFT", "CENTER", "RIGHT", "CROWD"].includes(candidate.zone)) return null;
    if (typeof candidate.imageDataUrl !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(candidate.imageDataUrl) || candidate.imageDataUrl.length > 750_000) return null;
    seen.add(candidate.id);
    cameras.push(candidate as LiveDirectorCamera);
  }
  return cameras;
}

export async function directLiveCameras(cameras: LiveDirectorCamera[], env: LiveDirectorEnv): Promise<LiveDirectorResult> {
  const fallback = fallbackDecision(cameras);
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { state: "deterministic", provider: "deterministic", model: null, decision: fallback, reason: "OpenAI is not configured." };

  const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const content: Array<Record<string, unknown>> = [{
      type: "input_text",
      text: "Choose the strongest live concert program view from these real synchronized cameras. Favor an unobstructed performer, strong framing, and genuinely different stage sides. Use one HERO or two complementary DUO cameras. Return only supplied camera IDs.",
    }];
    cameras.forEach((camera) => {
      content.push({ type: "input_text", text: `CAMERA ${camera.id} · DECLARED ${camera.zone} · ${camera.label}` });
      content.push({ type: "input_image", image_url: camera.imageDataUrl, detail: "low" });
    });
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 500,
        input: [
          { role: "system", content: "You are ManyVue's live concert vision director. Make a truthful production decision from the supplied frames only. Never invent camera positions or subjects." },
          { role: "user", content },
        ],
        text: { verbosity: "low", format: { type: "json_schema", name: "manyvue_live_director", strict: true, schema: DECISION_SCHEMA } },
      }),
    });
    if (!response.ok) return { state: "deterministic", provider: "deterministic", model, decision: fallback, reason: `OpenAI returned ${response.status}.` };
    const raw = extractText(await response.json());
    if (!raw) return { state: "deterministic", provider: "deterministic", model, decision: fallback, reason: "OpenAI returned no decision." };
    const decision = validateDecision(JSON.parse(raw), cameras);
    if (!decision) return { state: "deterministic", provider: "deterministic", model, decision: fallback, reason: "OpenAI returned an invalid camera decision." };
    return { state: "generated", provider: "openai", model, decision };
  } catch (error) {
    return { state: "deterministic", provider: "deterministic", model, decision: fallback, reason: error instanceof Error ? error.message : "Live vision failed." };
  } finally {
    clearTimeout(timeout);
  }
}
