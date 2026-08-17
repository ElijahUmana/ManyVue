export type RecorderStreamLease = {
  stream: MediaStream;
  isolated: boolean;
  release(): void;
};

export function recorderCanvasSize(width: number, height: number, maxLongEdge = 960) {
  const safeWidth = Math.max(2, Math.round(width) || 1280);
  const safeHeight = Math.max(2, Math.round(height) || 960);
  const scale = Math.min(1, maxLongEdge / Math.max(safeWidth, safeHeight));
  const even = (value: number) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(safeWidth), height: even(safeHeight) };
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("Camera frames did not become available for local recording.")), 5_000);
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error(video.error?.message || "Camera preview could not be decoded."));
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/**
 * Mobile WebKit can starve a WebRTC publication when MediaRecorder encodes the
 * exact same hardware camera track. A canvas relay gives local persistence a
 * software-backed video source while LiveKit keeps the untouched camera track.
 * Unsupported browsers fall back honestly to the source stream.
 */
export async function createRecorderStreamLease(
  source: MediaStream,
  isolateVideo: boolean,
): Promise<RecorderStreamLease> {
  const canvas = document.createElement("canvas");
  const captureStream = (canvas as HTMLCanvasElement & {
    captureStream?: (frameRate?: number) => MediaStream;
  }).captureStream;
  if (!isolateVideo || typeof captureStream !== "function") {
    return { stream: source, isolated: false, release: () => undefined };
  }

  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.srcObject = new MediaStream(source.getVideoTracks());
  try {
    await video.play();
    await waitForVideo(video);
  } catch {
    video.pause();
    video.srcObject = null;
    return { stream: source, isolated: false, release: () => undefined };
  }

  const settings = source.getVideoTracks()[0]?.getSettings();
  const size = recorderCanvasSize(
    video.videoWidth || settings?.width || 1280,
    video.videoHeight || settings?.height || 960,
  );
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    video.pause();
    video.srcObject = null;
    return { stream: source, isolated: false, release: () => undefined };
  }

  let released = false;
  let animationFrame = 0;
  const draw = () => {
    if (released) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    animationFrame = window.requestAnimationFrame(draw);
  };
  draw();

  const stream = captureStream.call(canvas, 24);
  for (const audioTrack of source.getAudioTracks()) stream.addTrack(audioTrack.clone());

  return {
    stream,
    isolated: true,
    release: () => {
      if (released) return;
      released = true;
      window.cancelAnimationFrame(animationFrame);
      stream.getTracks().forEach((track) => track.stop());
      video.pause();
      video.srcObject = null;
      canvas.width = 2;
      canvas.height = 2;
    },
  };
}
