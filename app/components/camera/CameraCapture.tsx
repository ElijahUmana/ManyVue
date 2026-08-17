"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DurableMediaRecorder,
  LiveMediaReconnectCoordinator,
  RollingBurstBuffer,
  SceneScheduler,
  ServerClock,
  mediaChunkStore,
  unconfiguredLiveMediaAdapter,
  type AppliedScene,
  type BurstCapture,
  type DurableRecordingResult,
  type LiveKitConnectOptions,
  type LiveMediaAdapter,
  type LiveMediaStatus,
  type RecordingState,
  type SceneRecipe,
  type StoredRecording,
} from "@/lib/media";
import styles from "./camera.module.css";

export interface SharedBurstMarker {
  id: string;
  serverMomentMs: number;
  initiatedBy: string;
  clusterId?: string;
}

export interface CameraCaptureProps {
  participantId: string;
  cameraId: string;
  adapter?: LiveMediaAdapter;
  liveKitConnection?: LiveKitConnectOptions;
  sceneRecipe?: SceneRecipe | null;
  foregroundCameraId?: string | null;
  incomingBurst?: SharedBurstMarker | null;
  clock?: ServerClock;
  includeLocalAudio?: boolean;
  onRecordingStarted?: (detail: {
    recordingId: string;
    cameraId: string;
    stream: MediaStream;
    mimeType: string;
  }) => void;
  onRecordingStopped?: (result: DurableRecordingResult) => void;
  onSceneApplied?: (scene: AppliedScene) => void;
  onBurstRequested?: (request: {
    participantId: string;
    cameraId: string;
    recordingId: string;
    localMomentMs: number;
  }) => Promise<SharedBurstMarker>;
  onBurstCaptured?: (capture: BurstCapture) => void;
  onRecoveryFound?: (recordings: StoredRecording[]) => void;
}

function mediaFailureMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Camera access was denied. Allow camera and microphone access, then try again.";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "No compatible camera is available on this device.";
    }
    if (error.name === "NotReadableError") {
      return "Another app is using the camera. Close it, then try again.";
    }
  }
  return error instanceof Error ? error.message : "The camera could not start.";
}

async function requestCamera(includeLocalAudio: boolean): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera recording requires a secure HTTPS page and a supported browser.");
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: includeLocalAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48_000 },
        }
      : false,
  });
}

export function CameraCapture({
  participantId,
  cameraId,
  adapter = unconfiguredLiveMediaAdapter,
  liveKitConnection,
  sceneRecipe,
  foregroundCameraId,
  incomingBurst,
  clock: suppliedClock,
  includeLocalAudio = true,
  onRecordingStarted,
  onRecordingStopped,
  onSceneApplied,
  onBurstRequested,
  onBurstCaptured,
  onRecoveryFound,
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<DurableMediaRecorder | null>(null);
  const burstBufferRef = useRef<RollingBurstBuffer | null>(null);
  const reconnectRef = useRef<LiveMediaReconnectCoordinator | null>(null);
  const handledBurstsRef = useRef(new Set<string>());
  const schedulerRef = useRef<SceneScheduler | null>(null);
  const [localClock] = useState(() => new ServerClock());
  const clock = suppliedClock ?? localClock;
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [liveStatus, setLiveStatus] = useState<LiveMediaStatus>(adapter.status);
  const [liveIssue, setLiveIssue] = useState<string | null>(null);
  const [cameraIssue, setCameraIssue] = useState<string | null>(null);
  const [appliedScene, setAppliedScene] = useState<AppliedScene | null>(null);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [burstState, setBurstState] = useState<"idle" | "catching" | "caught" | "failed">(
    "idle",
  );
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    const remove = adapter.onStatus((status, error) => {
      setLiveStatus(status);
      if (error) setLiveIssue(error.message);
      if (status === "connected") setLiveIssue(null);
    });
    return remove;
  }, [adapter]);

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void mediaChunkStore.recoverRecordings().then((recordings) => {
      const recoverable = recordings.filter(
        (recording) =>
          recording.participantId === participantId &&
          (recording.status === "interrupted" || recording.status === "complete"),
      );
      if (active && recoverable.length) onRecoveryFound?.(recoverable);
    });
    return () => {
      active = false;
    };
  }, [onRecoveryFound, participantId]);

  useEffect(() => {
    schedulerRef.current?.cancelPending();
    schedulerRef.current = new SceneScheduler(clock, (scene) => {
      setAppliedScene(scene);
      onSceneApplied?.(scene);
    });
    return () => schedulerRef.current?.cancelPending();
  }, [clock, onSceneApplied]);

  const isLive = Boolean(
    appliedScene &&
      (appliedScene.layout === "duo"
        ? appliedScene.activeCameraIds.includes(cameraId)
        : (foregroundCameraId ?? appliedScene.activeCameraIds[0]) === cameraId),
  );

  useEffect(() => {
    if (isLive && "vibrate" in navigator) navigator.vibrate?.(70);
  }, [isLive]);

  useEffect(() => {
    if (sceneRecipe) schedulerRef.current?.schedule(sceneRecipe);
  }, [sceneRecipe]);

  const captureSharedBurst = useCallback(
    async (marker: SharedBurstMarker) => {
      const buffer = burstBufferRef.current;
      if (!buffer || handledBurstsRef.current.has(marker.id)) return;
      handledBurstsRef.current.add(marker.id);
      setBurstState("catching");
      try {
        const capture = await buffer.capture({
          id: marker.id,
          participantId,
          serverMomentMs: marker.serverMomentMs,
          clusterId: marker.clusterId,
        });
        setBurstState("caught");
        onBurstCaptured?.(capture);
        window.setTimeout(() => setBurstState("idle"), 2_400);
      } catch (error) {
        setBurstState("failed");
        setCameraIssue(
          error instanceof Error ? error.message : "This Crowd Burst could not be preserved.",
        );
      }
    },
    [onBurstCaptured, participantId],
  );

  useEffect(() => {
    if (!incomingBurst) return;
    const timer = window.setTimeout(() => void captureSharedBurst(incomingBurst), 0);
    return () => window.clearTimeout(timer);
  }, [captureSharedBurst, incomingBurst]);

  useEffect(
    () => () => {
      reconnectRef.current?.stop();
      void adapter
        .unpublishCamera(cameraId)
        .catch((error) => console.error("ManyVue camera unpublish failed during cleanup.", error));
      if (recorderRef.current?.state !== "inactive") {
        void recorderRef.current
          ?.stop()
          .catch((error) => console.error("ManyVue recording finalization failed during cleanup.", error));
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [adapter, cameraId, downloadUrl],
  );

  const startRecording = useCallback(async () => {
    if (recordingState === "requesting" || recordingState === "recording") return;
    setRecordingState("requesting");
    setCameraIssue(null);
    setLiveIssue(null);
    setDownloadUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });

    try {
      const stream = await requestCamera(includeLocalAudio);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const recordingId = crypto.randomUUID();
      const recorder = new DurableMediaRecorder(stream, {
        recordingId,
        participantId,
      });
      await recorder.start();
      recorderRef.current = recorder;
      burstBufferRef.current = new RollingBurstBuffer(recorder, clock);
      setRecordingState("recording");
      onRecordingStarted?.({
        recordingId,
        cameraId,
        stream,
        mimeType: recorder.mimeType,
      });

      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.addEventListener(
        "ended",
        () => setCameraIssue("The camera stopped. Your saved chunks remain recoverable."),
        { once: true },
      );

      if (!adapter.configured) {
        setLiveIssue(
          "Live production is not configured. Your original is recording locally, but this angle is not live.",
        );
      } else if (liveKitConnection) {
        const reconnect = new LiveMediaReconnectCoordinator(adapter);
        reconnectRef.current = reconnect;
        try {
          await reconnect.start(liveKitConnection, { stream, cameraId });
        } catch (error) {
          setLiveIssue(
            error instanceof Error
              ? error.message
              : "Your original is safe, but the live connection failed.",
          );
        }
      } else if (adapter.status === "connected") {
        try {
          await adapter.publishCamera(stream, cameraId);
        } catch (error) {
          setLiveIssue(
            error instanceof Error
              ? error.message
              : "Your original is safe, but the angle did not publish.",
          );
        }
      } else {
        setLiveIssue(
          "A LiveKit participant token is required before this angle can enter the production.",
        );
      }
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraIssue(mediaFailureMessage(error));
      setRecordingState("error");
    }
  }, [
    adapter,
    cameraId,
    clock,
    includeLocalAudio,
    liveKitConnection,
    onRecordingStarted,
    participantId,
    recordingState,
  ]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recordingState !== "recording") return;
    setRecordingState("stopping");
    setAppliedScene(null);
    reconnectRef.current?.stop();
    reconnectRef.current = null;
    try {
      try {
        await adapter.unpublishCamera(cameraId);
      } catch (error) {
        setLiveIssue(
          error instanceof Error
            ? error.message
            : "The angle did not leave the live room cleanly; your original is still being saved.",
        );
      }
      const result = await recorder.stop();
      const url = URL.createObjectURL(result.blob);
      setDownloadUrl(url);
      setRecordingState("stopped");
      onRecordingStopped?.(result);
    } catch (error) {
      setCameraIssue(
        error instanceof Error ? error.message : "The recording could not be finalized.",
      );
      setRecordingState("error");
    } finally {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      burstBufferRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    }
  }, [adapter, cameraId, onRecordingStopped, recordingState]);

  const requestBurst = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recordingState !== "recording" || burstState === "catching") return;
    if (!onBurstRequested) {
      setCameraIssue("Crowd Burst requires the shared session connection; no fake local Burst was created.");
      return;
    }
    setBurstState("catching");
    setCameraIssue(null);
    try {
      const localMomentMs = Date.now();
      const marker = await onBurstRequested({
        participantId,
        cameraId,
        recordingId: recorder.recordingId,
        localMomentMs,
      });
      await captureSharedBurst(marker);
    } catch (error) {
      setBurstState("failed");
      setCameraIssue(
        error instanceof Error ? error.message : "The shared Crowd Burst request failed.",
      );
    }
  }, [
    burstState,
    cameraId,
    captureSharedBurst,
    onBurstRequested,
    participantId,
    recordingState,
  ]);

  const statusCopy = useMemo(() => {
    if (recordingState === "requesting") return "Opening your camera…";
    if (recordingState === "stopping") return "Securing your original…";
    if (recordingState !== "recording") return "Ready when the moment hits";
    if (!isOnline) return "Offline — original still recording safely";
    if (liveStatus === "connected") return isLive ? "Your angle is live" : "Recording · live angle ready";
    if (liveStatus === "reconnecting") return "Reconnecting · original still recording";
    return "Original recording · live angle unavailable";
  }, [isLive, isOnline, liveStatus, recordingState]);

  const isRecording = recordingState === "recording";

  return (
    <section
      className={`${styles.cameraShell} ${isLive ? styles.isLive : ""}`}
      aria-label="ManyVue camera"
    >
      <video
        ref={videoRef}
        className={styles.preview}
        muted
        playsInline
        autoPlay
        aria-label="Your live camera preview"
      />
      <div className={styles.scrim} aria-hidden="true" />

      <header className={styles.topBar}>
        <div className={styles.brand}>MANYVUE</div>
        <div className={`${styles.livePill} ${isLive ? styles.livePillActive : ""}`}>
          <span className={styles.statusDot} aria-hidden="true" />
          {isLive ? "YOUR ANGLE IS LIVE" : isRecording ? "ANGLE READY" : "STANDBY"}
        </div>
      </header>

      <div className={styles.statusRegion} aria-live="polite" aria-atomic="true">
        <span className={styles.recordDot} aria-hidden="true" />
        {statusCopy}
      </div>

      {(cameraIssue || liveIssue) && (
        <div className={styles.issue} role="alert">
          {cameraIssue ?? liveIssue}
        </div>
      )}

      <div className={styles.controls}>
        {!isRecording ? (
          <button
            type="button"
            className={styles.startButton}
            onClick={startRecording}
            disabled={recordingState === "requesting" || recordingState === "stopping"}
          >
            <span className={styles.startGlyph} aria-hidden="true" />
            {recordingState === "requesting" ? "OPENING CAMERA" : "START MY ANGLE"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.burstButton} ${burstState === "caught" ? styles.burstCaught : ""}`}
              onClick={requestBurst}
              disabled={burstState === "catching"}
              aria-describedby="burst-help"
            >
              <span className={styles.burstIcon} aria-hidden="true">✦</span>
              {burstState === "catching"
                ? "CATCHING EVERY ANGLE"
                : burstState === "caught"
                  ? "CROWD BURST CAUGHT"
                  : "BURST THIS MOMENT"}
            </button>
            <span id="burst-help" className={styles.visuallyHidden}>
              Saves this moment from your angle and every active crowd camera.
            </span>
            <button
              type="button"
              className={styles.stopButton}
              onClick={stopRecording}
              aria-label="Stop and save my angle"
            >
              <span aria-hidden="true" />
              STOP
            </button>
          </>
        )}

        {downloadUrl && (
          <a
            className={styles.downloadLink}
            href={downloadUrl}
            download={`manyvue-${cameraId}.webm`}
          >
            SAVE MY ORIGINAL
          </a>
        )}
      </div>
    </section>
  );
}
