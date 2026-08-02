import { fetchFestivalNow } from "@/lib/artifacts/jambase";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await fetchFestivalNow(
    {
      name: url.searchParams.get("name")?.trim() || "Outside Lands",
      ...(url.searchParams.get("startDateFrom") ? { startDateFrom: url.searchParams.get("startDateFrom") as string } : {}),
      ...(url.searchParams.get("startDateTo") ? { startDateTo: url.searchParams.get("startDateTo") as string } : {}),
    },
    {
      JAMBASE_API_KEY: process.env.JAMBASE_API_KEY,
      JAMBASE_API_BASE_URL: process.env.JAMBASE_API_BASE_URL,
    },
  );
  const status = result.state === "ready" ? 200 : result.state === "unconfigured" ? 503 : result.status === 400 ? 400 : 502;
  return Response.json(result, { status });
}

