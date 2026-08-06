import { planManyVueEdit } from "@/lib/ai/openai-edit-planner";
import { validateEditRecipeInput } from "@/lib/ai/edit-recipe";
import { runtimeValue } from "@/lib/runtime/environment";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    service: "openai-edit-planner",
    state: runtimeValue("OPENAI_API_KEY") ? "configured" : "unconfigured",
    model: runtimeValue("OPENAI_MODEL") || "gpt-5.6-sol",
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

function planCrowCutEditCompat(input: Parameters<typeof planManyVueEdit>[0]) {
  return planManyVueEdit(input, {
    OPENAI_API_KEY: runtimeValue("OPENAI_API_KEY"),
    OPENAI_MODEL: runtimeValue("OPENAI_MODEL"),
  });
}
