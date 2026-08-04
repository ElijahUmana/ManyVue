import {
  EDIT_RECIPE_JSON_SCHEMA,
  buildDeterministicEditRecipe,
  validateEditRecipe,
  type EditRecipe,
  type EditRecipeInput,
} from "./edit-recipe";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6-sol";

export interface OpenAIPlannerEnv {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export type EditPlanningResult =
  | {
      state: "generated";
      provider: "openai";
      model: string;
      recipe: EditRecipe;
      responseId: string | null;
    }
  | {
      state: "unconfigured";
      provider: "deterministic";
      model: null;
      reason: string;
      fallbackRecipe: EditRecipe;
    }
  | {
      state: "degraded";
      provider: "deterministic";
      model: string;
      reason: string;
      fallbackRecipe: EditRecipe;
    };

function buildVisionContent(input: EditRecipeInput): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: [
        `Artifact: ${input.artifactId}`,
        `Owner camera: ${input.ownerCameraId}`,
        `Exact output duration: ${input.durationMs}ms`,
        "When a source includes a following image, it is a low-resolution contact sheet from that real source clip.",
        "Use only supplied source IDs. Preserve a gapless timeline. Open and close on the owner's source.",
      ].join("\n"),
    },
  ];

  for (const candidate of input.candidates) {
    content.push({
      type: "input_text",
      text: JSON.stringify({
        sourceId: candidate.id,
        cameraId: candidate.cameraId,
        owner: candidate.cameraId === input.ownerCameraId,
        availableDurationMs: candidate.availableDurationMs,
        burstOffsetMs: candidate.burstOffsetMs,
        deterministicQualityScore: candidate.qualityScore,
        roleHint: candidate.roleHint ?? null,
      }),
    });
    if (candidate.contactSheetUrl) {
      content.push({ type: "input_image", image_url: candidate.contactSheetUrl, detail: "low" });
    }
  }
  return content;
}

export function buildOpenAIEditRequest(input: EditRecipeInput, model = DEFAULT_MODEL): Record<string, unknown> {
  return {
    model,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 2_500,
    input: [
      {
        role: "system",
        content: [
          "You are the ManyVue post-capture film editor.",
          "Create an energetic but truthful 9:16 concert edit from real supplied sources only.",
          "AI chooses the edit; it never invents footage. Favor view diversity and visible subjects over noisy rapid cutting.",
          "The first and final shots must use the owner camera with role owner.",
          "Shots must be contiguous, must end exactly at durationMs, and every source range must fit its available duration.",
          "Use subtle source audio under the master soundtrack. Crop conservatively; never remove the entire frame.",
        ].join(" "),
      },
      { role: "user", content: buildVisionContent(input) },
    ],
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "crowdcut_edit_recipe",
        strict: true,
        schema: EDIT_RECIPE_JSON_SCHEMA,
      },
    },
  };
}

export function extractResponseText(payload: unknown): { text: string | null; refusal: string | null; responseId: string | null } {
  if (typeof payload !== "object" || payload === null) return { text: null, refusal: null, responseId: null };
  const response = payload as { id?: unknown; output?: unknown };
  let text: string | null = null;
  let refusal: string | null = null;
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (typeof item !== "object" || item === null || !Array.isArray((item as { content?: unknown }).content)) continue;
      for (const content of (item as { content: unknown[] }).content) {
        if (typeof content !== "object" || content === null) continue;
        const part = content as { type?: unknown; text?: unknown; refusal?: unknown };
        if (part.type === "output_text" && typeof part.text === "string") text = `${text ?? ""}${part.text}`;
        if (part.type === "refusal" && typeof part.refusal === "string") refusal = part.refusal;
      }
    }
  }
  return { text, refusal, responseId: typeof response.id === "string" ? response.id : null };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function readableError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "OpenAI planning timed out";
  return error instanceof Error ? error.message : "Unknown OpenAI planning failure";
}

export async function planManyVueEdit(
  input: EditRecipeInput,
  env: OpenAIPlannerEnv,
  options: { timeoutMs?: number } = {},
): Promise<EditPlanningResult> {
  const fallbackRecipe = buildDeterministicEditRecipe(input);
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      state: "unconfigured",
      provider: "deterministic",
      model: null,
      reason: "OPENAI_API_KEY is not configured; the returned fallback is explicitly deterministic, not AI-generated.",
      fallbackRecipe,
    };
  }

  const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  try {
    const response = await fetchWithTimeout(
      OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildOpenAIEditRequest(input, model)),
      },
      options.timeoutMs ?? 18_000,
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      return {
        state: "degraded",
        provider: "deterministic",
        model,
        reason: `OpenAI returned HTTP ${response.status}: ${detail}`,
        fallbackRecipe,
      };
    }

    const payload: unknown = await response.json();
    const extracted = extractResponseText(payload);
    if (extracted.refusal) {
      return {
        state: "degraded",
        provider: "deterministic",
        model,
        reason: `OpenAI refused the edit request: ${extracted.refusal}`,
        fallbackRecipe,
      };
    }
    if (!extracted.text) {
      return {
        state: "degraded",
        provider: "deterministic",
        model,
        reason: "OpenAI completed without a structured edit recipe.",
        fallbackRecipe,
      };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(extracted.text);
    } catch {
      return {
        state: "degraded",
        provider: "deterministic",
        model,
        reason: "OpenAI returned output that was not valid JSON despite the strict response schema.",
        fallbackRecipe,
      };
    }
    const validated = validateEditRecipe(decoded, input);
    if (!validated.ok) {
      return {
        state: "degraded",
        provider: "deterministic",
        model,
        reason: `OpenAI recipe failed semantic validation: ${validated.errors.join("; ")}`,
        fallbackRecipe,
      };
    }
    return { state: "generated", provider: "openai", model, recipe: validated.value, responseId: extracted.responseId };
  } catch (error) {
    return { state: "degraded", provider: "deterministic", model, reason: readableError(error), fallbackRecipe };
  }
}
