import type { EditCandidate } from "../ai/edit-recipe";

export type BurstUploadStage = "clip-upload" | "thumbnail-upload" | "listing";

export class BurstUploadError extends Error {
  constructor(
    readonly stage: BurstUploadStage,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BurstUploadError";
  }
}

export interface UploadedMediaAsset {
  key: string;
  url: string;
  duplicate: boolean;
}

export interface ListedMediaAsset {
  key: string;
  url: string;
  size: number;
  uploaded: string;
  contentType: string | null;
  metadata: Record<string, string>;
}

export interface BurstCaptureUploadInput {
  session: string;
  participant: string;
  burstId: string;
  clip: Blob;
  thumbnail?: Blob | null;
  durationMs: number;
  burstOffsetMs: number;
}

export interface BurstCaptureUploadResult {
  clip: UploadedMediaAsset;
  thumbnail: UploadedMediaAsset | null;
  thumbnailWarning: string | null;
}

type FetchLike = typeof fetch;
const MAX_SITES_UPLOAD_BYTES = 1_800_000;

function extensionFor(blob: Blob): string {
  const mime = blob.type.toLowerCase();
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  return "webm";
}

async function requestWithRetry(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(input, init);
      if (response.ok || response.status < 500 || attempt === attempts - 1) return response;
      lastError = new Error(`Upload service returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Media request failed.");
}

async function uploadOne(
  fetcher: FetchLike,
  input: {
    session: string;
    participant: string;
    burstId: string;
    kind: "burst-source" | "thumbnail";
    clientAssetId: string;
    blob: Blob;
    durationMs: number;
    burstOffsetMs: number;
  },
): Promise<UploadedMediaAsset> {
  const form = new FormData();
  form.set("session", input.session);
  form.set("participant", input.participant);
  form.set("burstId", input.burstId);
  form.set("kind", input.kind);
  form.set("clientAssetId", input.clientAssetId);
  form.set("durationMs", String(Math.max(1, Math.round(input.durationMs))));
  form.set("burstOffsetMs", String(Math.max(0, Math.round(input.burstOffsetMs))));
  form.set(
    "file",
    new File([input.blob], `${input.clientAssetId}.${extensionFor(input.blob)}`, {
      type: input.blob.type || "application/octet-stream",
    }),
  );
  const response = await requestWithRetry(fetcher, "/api/uploads", { method: "POST", body: form });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    key?: string;
    url?: string;
    duplicate?: boolean;
    error?: string;
  } | null;
  if (!response.ok || !payload?.ok || !payload.key || !payload.url) {
    throw new Error(payload?.error || `Media upload returned HTTP ${response.status}.`);
  }
  return { key: payload.key, url: payload.url, duplicate: payload.duplicate === true };
}

/**
 * Uploads the required Burst microclip first. Thumbnail extraction/upload is
 * deliberately non-fatal so Safari decode limitations can never relabel a
 * safely persisted original or Burst clip as failed.
 */
export async function uploadBurstCaptureAssets(
  input: BurstCaptureUploadInput,
  fetcher: FetchLike = fetch,
): Promise<BurstCaptureUploadResult> {
  if (input.clip.size > MAX_SITES_UPLOAD_BYTES) {
    throw new BurstUploadError(
      "clip-upload",
      `Burst microclip is ${input.clip.size} bytes; the four-second capture must stay below ${MAX_SITES_UPLOAD_BYTES} bytes.`,
    );
  }
  const stableBase = `burst-${input.burstId}-${input.participant}`;
  let clip: UploadedMediaAsset;
  try {
    clip = await uploadOne(fetcher, {
      ...input,
      kind: "burst-source",
      clientAssetId: `${stableBase}-clip`,
      blob: input.clip,
    });
  } catch (error) {
    throw new BurstUploadError(
      "clip-upload",
      error instanceof Error ? error.message : "The Burst microclip could not be uploaded.",
      error,
    );
  }

  if (!input.thumbnail) {
    return {
      clip,
      thumbnail: null,
      thumbnailWarning: "The real Burst clip is uploaded, but this browser could not extract an AI contact sheet.",
    };
  }

  try {
    const thumbnail = await uploadOne(fetcher, {
      ...input,
      kind: "thumbnail",
      clientAssetId: `${stableBase}-contact-sheet`,
      blob: input.thumbnail,
    });
    return { clip, thumbnail, thumbnailWarning: null };
  } catch (error) {
    return {
      clip,
      thumbnail: null,
      thumbnailWarning: error instanceof Error
        ? `The Burst clip is uploaded; contact-sheet upload failed: ${error.message}`
        : "The Burst clip is uploaded; contact-sheet upload failed.",
    };
  }
}

export async function listBurstAssets(
  session: string,
  burstId: string,
  fetcher: FetchLike = fetch,
): Promise<ListedMediaAsset[]> {
  const query = new URLSearchParams({ list: "1", session, burstId });
  let response: Response;
  try {
    response = await requestWithRetry(fetcher, `/api/uploads?${query}`, { cache: "no-store" });
  } catch (error) {
    throw new BurstUploadError("listing", "The Burst source listing could not be reached.", error);
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; assets?: ListedMediaAsset[] } | null;
  if (!response.ok || !payload?.ok || !Array.isArray(payload.assets)) {
    throw new BurstUploadError("listing", `Burst source listing returned HTTP ${response.status}.`);
  }
  return payload.assets;
}

/** Builds one deterministic source per real participant from an exact Burst
 * listing. A missing contact sheet degrades vision guidance, never the clip. */
export function burstEditCandidates(
  assets: ListedMediaAsset[],
  ownerCameraId: string,
): EditCandidate[] {
  const grouped = new Map<string, { clip?: ListedMediaAsset; thumbnail?: ListedMediaAsset }>();
  for (const asset of [...assets].sort((left, right) => left.uploaded.localeCompare(right.uploaded))) {
    const participant = asset.metadata.participant;
    if (!participant) continue;
    const current = grouped.get(participant) ?? {};
    if (asset.metadata.kind === "burst-source") current.clip = asset;
    if (asset.metadata.kind === "thumbnail" || asset.metadata.kind === "burst-contact-sheet") {
      current.thumbnail = asset;
    }
    grouped.set(participant, current);
  }
  return [...grouped.entries()].flatMap(([cameraId, pair]) => {
    const durationMs = Number(pair.clip?.metadata.durationMs);
    const burstOffsetMs = Number(pair.clip?.metadata.burstOffsetMs);
    if (
      !pair.clip ||
      !Number.isFinite(durationMs) ||
      durationMs < 3_000 ||
      !Number.isFinite(burstOffsetMs) ||
      burstOffsetMs < 0 ||
      burstOffsetMs > durationMs
    ) return [];
    return [{
      id: `${cameraId}-source`,
      cameraId,
      clipUrl: pair.clip.url,
      ...(pair.thumbnail ? { contactSheetUrl: pair.thumbnail.url } : {}),
      availableDurationMs: durationMs,
      burstOffsetMs,
      qualityScore: cameraId === ownerCameraId ? 0.92 : 0.82,
    }];
  });
}
