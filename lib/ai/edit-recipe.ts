export const EDIT_RECIPE_VERSION = "1.0" as const;

export const SHOT_ROLES = [
  "owner",
  "hero",
  "wide",
  "side",
  "reaction",
  "moving",
] as const;

export const EDIT_TRANSITIONS = [
  "cut",
  "fade",
  "wipeLeft",
  "wipeRight",
] as const;

export type ShotRole = (typeof SHOT_ROLES)[number];
export type EditTransition = (typeof EDIT_TRANSITIONS)[number];

export interface EditCandidate {
  id: string;
  cameraId: string;
  clipUrl: string;
  contactSheetUrl?: string;
  availableDurationMs: number;
  burstOffsetMs: number;
  qualityScore: number;
  roleHint?: Exclude<ShotRole, "owner">;
}

export interface EditRecipeInput {
  artifactId: string;
  ownerCameraId: string;
  durationMs: number;
  candidates: EditCandidate[];
}

export interface EditRecipeShot {
  sourceId: string;
  role: ShotRole;
  startMs: number;
  durationMs: number;
  sourceInMs: number;
  crop: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  transition: EditTransition;
  sourceVolume: number;
}

export interface EditRecipe {
  version: typeof EDIT_RECIPE_VERSION;
  artifactId: string;
  ownerCameraId: string;
  durationMs: number;
  summary: string;
  shots: EditRecipeShot[];
  audio: {
    masterVolume: number;
    fadeInMs: number;
    fadeOutMs: number;
  };
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function validateEditRecipeInput(value: unknown): ValidationResult<EditRecipeInput> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["input must be an object"] };

  if (!hasOnlyKeys(value, ["artifactId", "ownerCameraId", "durationMs", "candidates"])) {
    errors.push("input contains unsupported properties");
  }

  const artifactId = value.artifactId;
  const ownerCameraId = value.ownerCameraId;
  const durationMs = value.durationMs;
  const rawCandidates = value.candidates;

  if (typeof artifactId !== "string" || !idPattern.test(artifactId)) {
    errors.push("artifactId must be a safe non-empty identifier");
  }
  if (typeof ownerCameraId !== "string" || !idPattern.test(ownerCameraId)) {
    errors.push("ownerCameraId must be a safe non-empty identifier");
  }
  if (!isFiniteNumber(durationMs) || !Number.isInteger(durationMs) || durationMs < 8_000 || durationMs > 12_000) {
    errors.push("durationMs must be an integer from 8000 through 12000");
  }
  if (!Array.isArray(rawCandidates) || rawCandidates.length < 2 || rawCandidates.length > 12) {
    errors.push("candidates must contain 2 through 12 real sources");
  }

  const candidates: EditCandidate[] = [];
  const ids = new Set<string>();
  if (Array.isArray(rawCandidates)) {
    rawCandidates.forEach((candidate, index) => {
      const prefix = `candidates[${index}]`;
      if (!isRecord(candidate)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!hasOnlyKeys(candidate, [
        "id",
        "cameraId",
        "clipUrl",
        "contactSheetUrl",
        "availableDurationMs",
        "burstOffsetMs",
        "qualityScore",
        "roleHint",
      ])) {
        errors.push(`${prefix} contains unsupported properties`);
      }

      const id = candidate.id;
      const cameraId = candidate.cameraId;
      const availableDurationMs = candidate.availableDurationMs;
      const burstOffsetMs = candidate.burstOffsetMs;
      const qualityScore = candidate.qualityScore;
      const roleHint = candidate.roleHint;

      if (typeof id !== "string" || !idPattern.test(id)) errors.push(`${prefix}.id is invalid`);
      if (typeof cameraId !== "string" || !idPattern.test(cameraId)) errors.push(`${prefix}.cameraId is invalid`);
      if (!isHttpsUrl(candidate.clipUrl)) errors.push(`${prefix}.clipUrl must be HTTPS`);
      if (candidate.contactSheetUrl !== undefined && !isHttpsUrl(candidate.contactSheetUrl)) {
        errors.push(`${prefix}.contactSheetUrl must be HTTPS when supplied`);
      }
      if (!isFiniteNumber(availableDurationMs) || availableDurationMs < 3_000 || availableDurationMs > 120_000) {
        errors.push(`${prefix}.availableDurationMs must be from 3000 through 120000`);
      }
      if (!isFiniteNumber(burstOffsetMs) || burstOffsetMs < 0 || (isFiniteNumber(availableDurationMs) && burstOffsetMs > availableDurationMs)) {
        errors.push(`${prefix}.burstOffsetMs is outside its source clip`);
      }
      if (!isFiniteNumber(qualityScore) || qualityScore < 0 || qualityScore > 1) {
        errors.push(`${prefix}.qualityScore must be from 0 through 1`);
      }
      if (roleHint !== undefined && (roleHint === "owner" || !SHOT_ROLES.includes(roleHint as ShotRole))) {
        errors.push(`${prefix}.roleHint is invalid`);
      }
      if (typeof id === "string") {
        if (ids.has(id)) errors.push(`${prefix}.id must be unique`);
        ids.add(id);
      }

      if (
        typeof id === "string" &&
        typeof cameraId === "string" &&
        isHttpsUrl(candidate.clipUrl) &&
        isFiniteNumber(availableDurationMs) &&
        isFiniteNumber(burstOffsetMs) &&
        isFiniteNumber(qualityScore)
      ) {
        candidates.push({
          id,
          cameraId,
          clipUrl: candidate.clipUrl,
          ...(isHttpsUrl(candidate.contactSheetUrl) ? { contactSheetUrl: candidate.contactSheetUrl } : {}),
          availableDurationMs,
          burstOffsetMs,
          qualityScore,
          ...(roleHint === undefined ? {} : { roleHint: roleHint as Exclude<ShotRole, "owner"> }),
        });
      }
    });
  }

  if (typeof ownerCameraId === "string" && !candidates.some((candidate) => candidate.cameraId === ownerCameraId)) {
    errors.push("at least one candidate must belong to ownerCameraId");
  }

  if (errors.length > 0 || typeof artifactId !== "string" || typeof ownerCameraId !== "string" || !isFiniteNumber(durationMs)) {
    return { ok: false, errors };
  }
  return { ok: true, value: { artifactId, ownerCameraId, durationMs, candidates } };
}

export const EDIT_RECIPE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: [EDIT_RECIPE_VERSION] },
    artifactId: { type: "string" },
    ownerCameraId: { type: "string" },
    durationMs: { type: "integer", minimum: 8_000, maximum: 12_000 },
    summary: { type: "string", minLength: 1, maxLength: 240 },
    shots: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceId: { type: "string" },
          role: { type: "string", enum: [...SHOT_ROLES] },
          startMs: { type: "integer", minimum: 0, maximum: 12_000 },
          durationMs: { type: "integer", minimum: 500, maximum: 5_000 },
          sourceInMs: { type: "integer", minimum: 0, maximum: 120_000 },
          crop: {
            type: "object",
            additionalProperties: false,
            properties: {
              top: { type: "number", minimum: 0, maximum: 0.85 },
              bottom: { type: "number", minimum: 0, maximum: 0.85 },
              left: { type: "number", minimum: 0, maximum: 0.85 },
              right: { type: "number", minimum: 0, maximum: 0.85 },
            },
            required: ["top", "bottom", "left", "right"],
          },
          transition: { type: "string", enum: [...EDIT_TRANSITIONS] },
          sourceVolume: { type: "number", minimum: 0, maximum: 0.18 },
        },
        required: [
          "sourceId",
          "role",
          "startMs",
          "durationMs",
          "sourceInMs",
          "crop",
          "transition",
          "sourceVolume",
        ],
      },
    },
    audio: {
      type: "object",
      additionalProperties: false,
      properties: {
        masterVolume: { type: "number", minimum: 0.5, maximum: 1 },
        fadeInMs: { type: "integer", minimum: 0, maximum: 1_000 },
        fadeOutMs: { type: "integer", minimum: 0, maximum: 1_000 },
      },
      required: ["masterVolume", "fadeInMs", "fadeOutMs"],
    },
  },
  required: ["version", "artifactId", "ownerCameraId", "durationMs", "summary", "shots", "audio"],
} as const;

export function validateEditRecipe(value: unknown, input: EditRecipeInput): ValidationResult<EditRecipe> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["recipe must be an object"] };
  if (!hasOnlyKeys(value, ["version", "artifactId", "ownerCameraId", "durationMs", "summary", "shots", "audio"])) {
    errors.push("recipe contains unsupported properties");
  }
  if (value.version !== EDIT_RECIPE_VERSION) errors.push(`version must be ${EDIT_RECIPE_VERSION}`);
  if (value.artifactId !== input.artifactId) errors.push("artifactId does not match the requested artifact");
  if (value.ownerCameraId !== input.ownerCameraId) errors.push("ownerCameraId does not match the requested owner");
  if (value.durationMs !== input.durationMs) errors.push("durationMs does not match the requested duration");
  if (typeof value.summary !== "string" || value.summary.length < 1 || value.summary.length > 240) {
    errors.push("summary must contain 1 through 240 characters");
  }

  const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const shots: EditRecipeShot[] = [];
  if (!Array.isArray(value.shots) || value.shots.length < 3 || value.shots.length > 8) {
    errors.push("shots must contain 3 through 8 cuts");
  } else {
    let expectedStart = 0;
    value.shots.forEach((shot, index) => {
      const prefix = `shots[${index}]`;
      if (!isRecord(shot)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!hasOnlyKeys(shot, ["sourceId", "role", "startMs", "durationMs", "sourceInMs", "crop", "transition", "sourceVolume"])) {
        errors.push(`${prefix} contains unsupported properties`);
      }
      const candidate = typeof shot.sourceId === "string" ? candidates.get(shot.sourceId) : undefined;
      if (!candidate) errors.push(`${prefix}.sourceId is not a supplied real source`);
      if (!SHOT_ROLES.includes(shot.role as ShotRole)) errors.push(`${prefix}.role is invalid`);
      if (!Number.isInteger(shot.startMs) || shot.startMs !== expectedStart) errors.push(`${prefix}.startMs must continue the gapless timeline at ${expectedStart}`);
      if (!Number.isInteger(shot.durationMs) || (shot.durationMs as number) < 500 || (shot.durationMs as number) > 5_000) {
        errors.push(`${prefix}.durationMs is invalid`);
      }
      if (!Number.isInteger(shot.sourceInMs) || (shot.sourceInMs as number) < 0) errors.push(`${prefix}.sourceInMs is invalid`);
      if (!isFiniteNumber(shot.sourceVolume) || shot.sourceVolume < 0 || shot.sourceVolume > 0.18) {
        errors.push(`${prefix}.sourceVolume is invalid`);
      }
      if (!EDIT_TRANSITIONS.includes(shot.transition as EditTransition)) errors.push(`${prefix}.transition is invalid`);

      const crop = shot.crop;
      if (!isRecord(crop) || !hasOnlyKeys(crop, ["top", "bottom", "left", "right"])) {
        errors.push(`${prefix}.crop is invalid`);
      } else {
        const values = [crop.top, crop.bottom, crop.left, crop.right];
        if (!values.every((item) => isFiniteNumber(item) && item >= 0 && item <= 0.85)) {
          errors.push(`${prefix}.crop values must be from 0 through 0.85`);
        } else if ((crop.top as number) + (crop.bottom as number) >= 0.95 || (crop.left as number) + (crop.right as number) >= 0.95) {
          errors.push(`${prefix}.crop removes the entire frame`);
        }
      }

      if (candidate && isFiniteNumber(shot.sourceInMs) && isFiniteNumber(shot.durationMs) && shot.sourceInMs + shot.durationMs > candidate.availableDurationMs) {
        errors.push(`${prefix} exceeds the supplied source duration`);
      }
      if (isFiniteNumber(shot.durationMs)) expectedStart += shot.durationMs;

      if (
        candidate &&
        typeof shot.sourceId === "string" &&
        SHOT_ROLES.includes(shot.role as ShotRole) &&
        Number.isInteger(shot.startMs) &&
        Number.isInteger(shot.durationMs) &&
        Number.isInteger(shot.sourceInMs) &&
        isRecord(crop) &&
        [crop.top, crop.bottom, crop.left, crop.right].every(isFiniteNumber) &&
        EDIT_TRANSITIONS.includes(shot.transition as EditTransition) &&
        isFiniteNumber(shot.sourceVolume)
      ) {
        shots.push({
          sourceId: shot.sourceId,
          role: shot.role as ShotRole,
          startMs: shot.startMs as number,
          durationMs: shot.durationMs as number,
          sourceInMs: shot.sourceInMs as number,
          crop: crop as unknown as EditRecipeShot["crop"],
          transition: shot.transition as EditTransition,
          sourceVolume: shot.sourceVolume,
        });
      }
    });
    if (expectedStart !== input.durationMs) errors.push(`shots must end exactly at ${input.durationMs}ms`);
  }

  if (shots.length > 0) {
    const first = candidates.get(shots[0].sourceId);
    const last = candidates.get(shots[shots.length - 1].sourceId);
    if (first?.cameraId !== input.ownerCameraId || shots[0].role !== "owner") errors.push("the first shot must be the owner's real angle");
    if (last?.cameraId !== input.ownerCameraId || shots[shots.length - 1].role !== "owner") errors.push("the last shot must return to the owner's real angle");
  }

  const audio = value.audio;
  if (!isRecord(audio) || !hasOnlyKeys(audio, ["masterVolume", "fadeInMs", "fadeOutMs"])) {
    errors.push("audio is invalid");
  } else {
    if (!isFiniteNumber(audio.masterVolume) || audio.masterVolume < 0.5 || audio.masterVolume > 1) errors.push("audio.masterVolume is invalid");
    if (!Number.isInteger(audio.fadeInMs) || (audio.fadeInMs as number) < 0 || (audio.fadeInMs as number) > 1_000) errors.push("audio.fadeInMs is invalid");
    if (!Number.isInteger(audio.fadeOutMs) || (audio.fadeOutMs as number) < 0 || (audio.fadeOutMs as number) > 1_000) errors.push("audio.fadeOutMs is invalid");
  }

  if (errors.length > 0 || !isRecord(audio)) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: EDIT_RECIPE_VERSION,
      artifactId: input.artifactId,
      ownerCameraId: input.ownerCameraId,
      durationMs: input.durationMs,
      summary: value.summary as string,
      shots,
      audio: {
        masterVolume: audio.masterVolume as number,
        fadeInMs: audio.fadeInMs as number,
        fadeOutMs: audio.fadeOutMs as number,
      },
    },
  };
}

function roleFor(candidate: EditCandidate, ownerCameraId: string): ShotRole {
  return candidate.cameraId === ownerCameraId ? "owner" : candidate.roleHint ?? "hero";
}

function safeSourceIn(candidate: EditCandidate, durationMs: number): number {
  const desired = Math.round(candidate.burstOffsetMs - durationMs / 2);
  return Math.max(0, Math.min(desired, Math.max(0, candidate.availableDurationMs - durationMs)));
}

export function buildDeterministicEditRecipe(input: EditRecipeInput): EditRecipe {
  const ownerCandidates = input.candidates
    .filter((candidate) => candidate.cameraId === input.ownerCameraId)
    .sort((a, b) => b.qualityScore - a.qualityScore);
  if (ownerCandidates.length === 0) throw new Error("A deterministic edit requires the owner's real source");

  const owner = ownerCandidates[0];
  const otherCameras = input.candidates
    .filter((candidate) => candidate.cameraId !== input.ownerCameraId)
    .sort((a, b) => b.qualityScore - a.qualityScore);
  const chosen: EditCandidate[] = [owner];
  const usedCameras = new Set([owner.cameraId]);
  for (const candidate of otherCameras) {
    if (!usedCameras.has(candidate.cameraId) && chosen.length < 4) {
      chosen.push(candidate);
      usedCameras.add(candidate.cameraId);
    }
  }
  while (chosen.length < 4 && input.candidates.length > 1) {
    chosen.push(input.candidates[(chosen.length - 1) % input.candidates.length]);
  }

  const sequence = [owner, ...chosen.slice(1, 4), owner];
  const baseDuration = Math.floor(input.durationMs / sequence.length);
  let cursor = 0;
  const shots = sequence.map((candidate, index): EditRecipeShot => {
    const durationMs = index === sequence.length - 1 ? input.durationMs - cursor : baseDuration;
    const shot: EditRecipeShot = {
      sourceId: candidate.id,
      role: roleFor(candidate, input.ownerCameraId),
      startMs: cursor,
      durationMs,
      sourceInMs: safeSourceIn(candidate, durationMs),
      crop: { top: 0, bottom: 0, left: 0, right: 0 },
      transition: index === 0 ? "cut" : index % 2 === 0 ? "wipeLeft" : "cut",
      sourceVolume: candidate.cameraId === input.ownerCameraId ? 0.08 : 0.04,
    };
    cursor += durationMs;
    return shot;
  });

  return {
    version: EDIT_RECIPE_VERSION,
    artifactId: input.artifactId,
    ownerCameraId: input.ownerCameraId,
    durationMs: input.durationMs,
    summary: "Owner-anchored crowd sweep chosen by deterministic quality and viewpoint diversity.",
    shots,
    audio: { masterVolume: 1, fadeInMs: 120, fadeOutMs: 240 },
  };
}
