export type RecordingState =
  | "idle"
  | "requesting"
  | "ready"
  | "recording"
  | "stopping"
  | "stopped"
  | "error";

export type LiveMediaStatus =
  | "unconfigured"
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export type SceneLayout = "hero" | "duo" | "sweep";

export interface SceneRecipe {
  revision: number;
  layout: SceneLayout;
  activeCameraIds: string[];
  cutAtServerMs: number;
  durationMs?: number;
  reason?: "director" | "manual" | "failover" | "burst";
}

export interface AppliedScene extends SceneRecipe {
  appliedAtLocalMs: number;
  estimatedServerMs: number;
  latenessMs: number;
}

export interface CameraQualityMetrics {
  brightness: number;
  contrast: number;
  sharpness: number;
  motion: number;
  frozenFrames: number;
  sampledAtMs: number;
}

export type CameraQualityReason =
  | "dark"
  | "covered"
  | "blurred"
  | "frozen"
  | "excessive-motion"
  | "healthy";

export interface CameraQualityScore {
  score: number;
  usable: boolean;
  reasons: CameraQualityReason[];
  metrics: CameraQualityMetrics;
  fingerprint: Uint8Array;
}

export interface StoredRecording {
  id: string;
  participantId: string;
  mimeType: string;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number;
  stoppedAtMs?: number;
  status: "recording" | "complete" | "interrupted" | "failed";
  chunkCount: number;
  sizeBytes: number;
  error?: string;
}

export interface StoredMediaChunk {
  key: string;
  recordingId: string;
  sequence: number;
  startAtMs: number;
  endAtMs: number;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  uploadState: "pending" | "uploading" | "uploaded" | "failed";
  uploadAttempts: number;
  remoteStorageId?: string;
}

export interface StoredBurstMarker {
  id: string;
  recordingId: string;
  participantId: string;
  serverMomentMs: number;
  localMomentMs: number;
  preRollMs: number;
  postRollMs: number;
  createdAtMs: number;
  clusterId?: string;
}

export interface BurstCapture {
  marker: StoredBurstMarker;
  chunks: StoredMediaChunk[];
  blob: Blob;
  actualStartAtMs: number;
  actualEndAtMs: number;
}

export interface DurableRecordingResult {
  recording: StoredRecording;
  chunks: StoredMediaChunk[];
  blob: Blob;
}

export interface ProgramCameraSource {
  id: string;
  participantId: string;
  label: string;
  stream: MediaStream | null;
  connected: boolean;
  quality?: CameraQualityScore;
  mirrored?: boolean;
}

export interface BurstPerspective {
  cameraId: string;
  participantId: string;
  label: string;
  imageUrl?: string;
  stream?: MediaStream | null;
}

export interface ProgramBurst {
  id: string;
  initiatedBy: string;
  revealAtServerMs: number;
  durationMs: number;
  perspectives: BurstPerspective[];
}

export interface LiveMediaErrorShape {
  code:
    | "unconfigured"
    | "permission-denied"
    | "unsupported"
    | "connection-failed"
    | "publish-failed"
    | "storage-failed"
    | "recording-failed";
  message: string;
  cause?: unknown;
}
