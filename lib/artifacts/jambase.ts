const DEFAULT_JAMBASE_BASE_URL = "https://api.data.jambase.com/v3";

export interface JamBaseEnv {
  JAMBASE_API_KEY?: string;
  JAMBASE_API_BASE_URL?: string;
}

export interface FestivalNowQuery {
  name: string;
  startDateFrom?: string;
  startDateTo?: string;
}

export interface FestivalMetadata {
  eventId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  venue: {
    name: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
  };
  artists: string[];
  imageUrl: string | null;
  sourceUrl: string | null;
}

export type FestivalNowResult =
  | { state: "ready"; source: "jambase"; query: FestivalNowQuery; festivals: FestivalMetadata[] }
  | { state: "unconfigured"; source: "jambase"; reason: string; festivals: [] }
  | { state: "error"; source: "jambase"; reason: string; status: number | null; festivals: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function eventArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["events", "results", "items"]) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }
  if (isRecord(payload.data)) {
    for (const key of ["events", "results", "items"]) {
      if (Array.isArray(payload.data[key])) return payload.data[key] as unknown[];
    }
  }
  return [];
}

function artistNames(event: Record<string, unknown>): string[] {
  const candidates = [event.performer, event.performers, event.artists, event.lineup];
  const names: string[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const artist of candidate) {
      if (typeof artist === "string" && artist.trim()) names.push(artist.trim());
      else if (isRecord(artist)) {
        const name = stringAt(artist, "name", "artistName");
        if (name) names.push(name);
      }
    }
  }
  return [...new Set(names)].slice(0, 100);
}

function findImage(event: Record<string, unknown>): string | null {
  const direct = httpsUrl(event.image) ?? httpsUrl(event.imageUrl);
  if (direct) return direct;
  const images = event.images;
  if (Array.isArray(images)) {
    for (const image of images) {
      if (typeof image === "string") {
        const url = httpsUrl(image);
        if (url) return url;
      }
      if (isRecord(image)) {
        const url = httpsUrl(image.url) ?? httpsUrl(image.src);
        if (url) return url;
      }
    }
  }
  return null;
}

export function normalizeFestivalEvent(value: unknown): FestivalMetadata | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.event)) return normalizeFestivalEvent(value.event);
  const name = stringAt(value, "name", "title", "eventName");
  const eventId = stringAt(value, "id", "eventId", "identifier");
  if (!name || !eventId) return null;

  const location = isRecord(value.location) ? value.location : null;
  const venue = isRecord(value.venue) ? value.venue : location;
  const address = isRecord(location?.address) ? location.address : isRecord(venue?.address) ? venue.address : null;

  return {
    eventId,
    name,
    startDate: stringAt(value, "startDate", "startDateTime"),
    endDate: stringAt(value, "endDate", "endDateTime"),
    status: stringAt(value, "eventStatus", "status"),
    venue: {
      name: stringAt(venue, "name", "venueName"),
      city: stringAt(address, "addressLocality", "city"),
      region: stringAt(address, "addressRegion", "region", "state"),
      country: stringAt(address, "addressCountry", "country"),
    },
    artists: artistNames(value),
    imageUrl: findImage(value),
    sourceUrl: httpsUrl(value.url) ?? httpsUrl(value.eventUrl),
  };
}

export function normalizeFestivalResponse(payload: unknown): FestivalMetadata[] {
  const seen = new Set<string>();
  const festivals: FestivalMetadata[] = [];
  for (const event of eventArray(payload)) {
    const normalized = normalizeFestivalEvent(event);
    if (!normalized || seen.has(normalized.eventId)) continue;
    seen.add(normalized.eventId);
    festivals.push(normalized);
  }
  return festivals;
}

function validateQuery(query: FestivalNowQuery): string | null {
  if (!query.name.trim() || query.name.trim().length > 100) return "Festival name must contain 1 through 100 characters.";
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (query.startDateFrom && !date.test(query.startDateFrom)) return "startDateFrom must use YYYY-MM-DD.";
  if (query.startDateTo && !date.test(query.startDateTo)) return "startDateTo must use YYYY-MM-DD.";
  if (query.startDateFrom && query.startDateTo && query.startDateFrom > query.startDateTo) return "startDateFrom cannot be after startDateTo.";
  return null;
}

export function buildJamBaseEventsUrl(query: FestivalNowQuery, baseUrl = DEFAULT_JAMBASE_BASE_URL): string {
  const base = new URL(baseUrl.replace(/\/+$/, "") + "/events");
  if (base.protocol !== "https:") throw new Error("JamBase base URL must be HTTPS");
  base.searchParams.set("name", query.name.trim());
  if (query.startDateFrom) base.searchParams.set("startDateFrom", query.startDateFrom);
  if (query.startDateTo) base.searchParams.set("startDateTo", query.startDateTo);
  return base.toString();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchFestivalNow(query: FestivalNowQuery, env: JamBaseEnv): Promise<FestivalNowResult> {
  const validationError = validateQuery(query);
  if (validationError) return { state: "error", source: "jambase", reason: validationError, status: 400, festivals: [] };
  const apiKey = env.JAMBASE_API_KEY?.trim();
  if (!apiKey) {
    return {
      state: "unconfigured",
      source: "jambase",
      reason: "JAMBASE_API_KEY is not configured; no festival metadata has been fabricated.",
      festivals: [],
    };
  }
  try {
    const url = buildJamBaseEventsUrl(query, env.JAMBASE_API_BASE_URL?.trim() || DEFAULT_JAMBASE_BASE_URL);
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "ManyVueLive/1.0",
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 700);
      return { state: "error", source: "jambase", reason: `JamBase returned HTTP ${response.status}: ${detail}`, status: response.status, festivals: [] };
    }
    return { state: "ready", source: "jambase", query, festivals: normalizeFestivalResponse(await response.json()) };
  } catch (error) {
    return { state: "error", source: "jambase", reason: error instanceof Error ? error.message : "Unknown JamBase failure", status: null, festivals: [] };
  }
}
