import { planCrowdCutEdit } from "@/lib/ai/openai-edit-planner";
import { validateEditRecipeInput } from "@/lib/ai/edit-recipe";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    service: "openai-edit-planner",
    state: process.env.OPENAI_API_KEY ? "configured" : "unconfigured",
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
  });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ state: "invalid_request", errors: ["Request body must be JSON"] }, { status: 400 });
  }
  const validated = validateEditRecipeInput(payload);
  if (!validated.ok) return Response.json({ state: "invalid_request", errors: validated.errors }, { status: 400 });

  const result = await planCrowCutEditCompat(validated.value);
  return Response.json(result, { status: result.state === "generated" ? 201 : 200 });
}

function planCrowCutEditCompat(input: Parameters<typeof planCrowdCutEdit>[0]) {
  return planCrowdCutEdit(input, {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
  });
}

