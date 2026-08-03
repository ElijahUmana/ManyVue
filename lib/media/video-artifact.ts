export type VideoProbeSource = "metadata" | "fallback";

export interface VideoDurationProbe {
  durationMs: number;
  source: VideoProbeSource;
  warning?: string;
}

export type ContactSheetResult =
  | { ok: true; blob: Blob }
  | { ok: false; reason: string };

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function waitForMediaEvent(
  video: HTMLVideoElement,
  success: keyof HTMLMediaElementEventMap,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error(`Timed out waiting for video ${success}.`)), timeoutMs);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener(success, onSuccess);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onSuccess = () => finish();
    const onError = () => finish(new Error(video.error?.message || "The recorded video could not be decoded."));
    video.addEventListener(success, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function disposeVideo(video: HTMLVideoElement, url: string) {
  video.pause();
  video.removeAttribute("src");
  video.load();
  URL.revokeObjectURL(url);
}

function createBlobVideo(blob: Blob): { video: HTMLVideoElement; url: string } {
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  video.load();
  return { video, url };
}

/** Safari can produce a valid MediaRecorder blob whose metadata duration is
 * temporarily unavailable. Recording elapsed time is therefore a truthful,
 * explicit fallback instead of turning a successful save into an error. */
export async function probeVideoDurationMs(
  blob: Blob,
  fallbackDurationMs: number,
): Promise<VideoDurationProbe> {
  const fallback = Math.max(1, Math.round(fallbackDurationMs));
  const { video, url } = createBlobVideo(blob);
  try {
    await waitForMediaEvent(video, "loadedmetadata", 6_000);
    if (finitePositive(video.duration) && video.duration !== Infinity) {
      return { durationMs: Math.round(video.duration * 1_000), source: "metadata" };
    }
    return {
      durationMs: fallback,
      source: "fallback",
      warning: "Video metadata omitted duration; the recorder's measured elapsed time was used.",
    };
  } catch (error) {
    return {
      durationMs: fallback,
      source: "fallback",
      warning: error instanceof Error ? error.message : "Video metadata could not be read.",
    };
  } finally {
    disposeVideo(video, url);
  }
}

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0 || !video.seekable.length) {
    return Promise.reject(new Error("This recording is not seekable in the current browser."));
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("Timed out decoding a contact-sheet frame.")), 3_000);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error(video.error?.message || "A contact-sheet frame could not be decoded."));
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    try {
      video.currentTime = seconds;
    } catch (error) {
      finish(error instanceof Error ? error : new Error("The browser rejected a video seek."));
    }
  });
}

export async function tryCreateContactSheet(
  blob: Blob,
  burstOffsetMs: number,
): Promise<ContactSheetResult> {
  const { video, url } = createBlobVideo(blob);
  try {
    await waitForMediaEvent(video, "loadedmetadata", 6_000);
    const durationSeconds = video.duration;
    if (!finitePositive(durationSeconds) || durationSeconds === Infinity) {
      return { ok: false, reason: "This browser did not expose a seekable video duration." };
    }
    const sourceWidth = video.videoWidth || 720;
    const sourceHeight = video.videoHeight || 1280;
    const frameWidth = 320;
    const frameHeight = Math.max(180, Math.round(frameWidth * (sourceHeight / sourceWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = frameWidth * 3;
    canvas.height = frameHeight;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, reason: "Contact-sheet canvas is unavailable." };
    const latestSeek = Math.max(0, durationSeconds - 0.08);
    const centerSeconds = Math.min(latestSeek, Math.max(0, burstOffsetMs / 1_000));
    const timestamps = [-1.5, 0, 1.5].map((offset) =>
      Math.min(latestSeek, Math.max(0, centerSeconds + offset)),
    );
    for (let index = 0; index < timestamps.length; index += 1) {
      await seek(video, timestamps[index]);
      context.drawImage(video, index * frameWidth, 0, frameWidth, frameHeight);
    }
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
    return frame
      ? { ok: true, blob: frame }
      : { ok: false, reason: "The browser could not encode the contact sheet." };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Contact-sheet extraction failed.",
    };
  } finally {
    disposeVideo(video, url);
  }
}
