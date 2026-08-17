const RECORDER_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=h264,aac",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export interface RecorderCodecSelection {
  mimeType: string;
  extension: "mp4" | "webm";
  explicitlySupported: boolean;
}

export function negotiateRecorderCodec(
  mediaRecorder: typeof MediaRecorder | undefined =
    typeof MediaRecorder === "undefined" ? undefined : MediaRecorder,
): RecorderCodecSelection {
  if (!mediaRecorder) {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  for (const mimeType of RECORDER_MIME_CANDIDATES) {
    if (mediaRecorder.isTypeSupported(mimeType)) {
      return {
        mimeType,
        extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
        explicitlySupported: true,
      };
    }
  }

  // The empty mime type asks the browser to use its native default. This is
  // permitted by MediaRecorder and is more truthful than claiming a codec.
  return { mimeType: "", extension: "webm", explicitlySupported: false };
}

export function mediaRecorderOptions(
  selection: RecorderCodecSelection,
  videoBitsPerSecond = 6_000_000,
  audioBitsPerSecond = 128_000,
): MediaRecorderOptions {
  return {
    ...(selection.mimeType ? { mimeType: selection.mimeType } : {}),
    videoBitsPerSecond,
    ...(audioBitsPerSecond > 0 ? { audioBitsPerSecond } : {}),
  };
}

export function extensionForMimeType(mimeType: string): "mp4" | "webm" {
  return mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
}
