"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SceneScheduler,
  ServerClock,
  type AppliedScene,
  type BurstPerspective,
  type ProgramBurst,
  type ProgramCameraSource,
  type SceneRecipe,
} from "@/lib/media";
import styles from "./program.module.css";

interface StreamVideoProps {
  source: ProgramCameraSource;
  className?: string;
  foreground?: boolean;
}

function StreamVideo({ source, className = "", foreground = false }: StreamVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = source.stream;
    setPlaybackError(false);
    if (source.stream) {
      void video.play().catch(() => setPlaybackError(true));
    }
    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [source.stream]);

  const unavailable =
    !source.connected ||
    !source.stream ||
    source.stream.getVideoTracks().every((track) => track.readyState !== "live");

  return (
    <div
      className={`${styles.angle} ${className} ${source.mirrored ? styles.mirrored : ""}`}
      data-camera-id={source.id}
      data-foreground={foreground ? "true" : "false"}
    >
      <video ref={videoRef} className={styles.video} muted playsInline autoPlay />
      {(unavailable || playbackError) && (
        <div className={styles.angleUnavailable} role="status">
          <span className={styles.reconnectPulse} aria-hidden="true" />
          {playbackError ? "ANGLE NEEDS PLAYBACK PERMISSION" : "ANGLE RECONNECTING"}
        </div>
      )}
      <div className={styles.angleLabel}>
        <span aria-hidden="true" />
        {source.label}
      </div>
    </div>
  );
}

export interface HeroSceneProps {
  source: ProgramCameraSource;
}

export function HeroScene({ source }: HeroSceneProps) {
  return (
    <div className={styles.heroScene}>
      <StreamVideo source={source} foreground />
    </div>
  );
}

export interface DuoSceneProps {
  primary: ProgramCameraSource;
  secondary: ProgramCameraSource;
}

export function DuoScene({ primary, secondary }: DuoSceneProps) {
  return (
    <div className={styles.duoScene}>
      <StreamVideo source={primary} className={styles.duoPrimary} foreground />
      <StreamVideo source={secondary} className={styles.duoSecondary} />
      <div className={styles.duoSeam} aria-hidden="true" />
    </div>
  );
}

export interface SweepSceneProps {
  sources: ProgramCameraSource[];
  intervalMs?: number;
  onForegroundCameraChange?: (cameraId: string) => void;
}

export function SweepScene({
  sources,
  intervalMs = 760,
  onForegroundCameraChange,
}: SweepSceneProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (sources.length < 2) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % sources.length),
      Math.max(420, intervalMs),
    );
    return () => window.clearInterval(timer);
  }, [intervalMs, sources.length]);
  const safeIndex = sources.length ? index % sources.length : 0;
  useEffect(() => {
    if (sources[safeIndex]) onForegroundCameraChange?.(sources[safeIndex].id);
  }, [onForegroundCameraChange, safeIndex, sources]);

  return (
    <div className={styles.sweepScene}>
      {sources.map((source, sourceIndex) => (
        <StreamVideo
          key={source.id}
          source={source}
          className={`${styles.sweepAngle} ${sourceIndex === safeIndex ? styles.sweepAngleActive : ""}`}
          foreground={sourceIndex === safeIndex}
        />
      ))}
      <div className={styles.sweepProgress} aria-label={`Angle ${safeIndex + 1} of ${sources.length}`}>
        {sources.map((source, dotIndex) => (
          <span key={source.id} data-active={dotIndex === safeIndex ? "true" : "false"} />
        ))}
      </div>
    </div>
  );
}

function BurstFrame({ perspective }: { perspective: BurstPerspective }) {
  const source: ProgramCameraSource = {
    id: perspective.cameraId,
    participantId: perspective.participantId,
    label: perspective.label,
    stream: perspective.stream ?? null,
    connected: Boolean(perspective.stream),
  };

  return perspective.imageUrl ? (
    <div className={styles.burstStill}>
      {/* The URL is produced from an actual captured Burst frame upstream. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={perspective.imageUrl} alt={`Crowd Burst perspective from ${perspective.label}`} />
      <div className={styles.angleLabel}>{perspective.label}</div>
    </div>
  ) : (
    <StreamVideo source={source} foreground />
  );
}

interface CrowdBurstRevealProps {
  burst: ProgramBurst;
  onForegroundCameraChange?: (cameraId: string) => void;
  onComplete?: () => void;
}

export function CrowdBurstReveal({
  burst,
  onForegroundCameraChange,
  onComplete,
}: CrowdBurstRevealProps) {
  const [index, setIndex] = useState(0);
  const perspectiveCount = burst.perspectives.length;
  const intervalMs = Math.max(260, Math.floor(burst.durationMs / Math.max(1, perspectiveCount)));

  useEffect(() => {
    if (!perspectiveCount) {
      onComplete?.();
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= perspectiveCount - 1) {
          window.clearInterval(timer);
          window.setTimeout(() => onComplete?.(), intervalMs);
          return current;
        }
        return current + 1;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [burst.id, intervalMs, onComplete, perspectiveCount]);

  useEffect(() => {
    const perspective = burst.perspectives[index];
    if (perspective) onForegroundCameraChange?.(perspective.cameraId);
  }, [burst.perspectives, index, onForegroundCameraChange]);

  const current = burst.perspectives[index];
  if (!current) return null;

  return (
    <div className={styles.burstReveal} role="status" aria-live="polite">
      <BurstFrame perspective={current} />
      <div className={styles.burstFlash} aria-hidden="true" key={`${burst.id}:${index}`} />
      <div className={styles.burstTitle}>
        <span>CROWD BURST</span>
        <strong>{index + 1} / {perspectiveCount}</strong>
      </div>
    </div>
  );
}

export interface ProgramViewProps {
  cameras: ProgramCameraSource[];
  sceneRecipe?: SceneRecipe | null;
  burst?: ProgramBurst | null;
  clock?: ServerClock;
  qrSlot?: ReactNode;
  eyebrow?: string;
  title?: string;
  onSceneApplied?: (scene: AppliedScene) => void;
  onForegroundCameraChange?: (cameraId: string | null) => void;
  onBurstComplete?: (burstId: string) => void;
  showDiagnostics?: boolean;
}

export function ProgramView({
  cameras,
  sceneRecipe,
  burst,
  clock: suppliedClock,
  qrSlot,
  eyebrow = "LIVE CROWD PRODUCTION",
  title = "ManyVue Live",
  onSceneApplied,
  onForegroundCameraChange,
  onBurstComplete,
  showDiagnostics = false,
}: ProgramViewProps) {
  const [localClock] = useState(() => new ServerClock());
  const clock = suppliedClock ?? localClock;
  const [appliedScene, setAppliedScene] = useState<AppliedScene | null>(null);
  const [activeBurst, setActiveBurst] = useState<ProgramBurst | null>(null);
  const schedulerRef = useRef<SceneScheduler | null>(null);
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    schedulerRef.current?.cancelPending();
    schedulerRef.current = new SceneScheduler(clock, (scene) => {
      setAppliedScene(scene);
      onSceneApplied?.(scene);
      onForegroundCameraChange?.(scene.activeCameraIds[0] ?? null);
    });
    return () => schedulerRef.current?.cancelPending();
  }, [clock, onForegroundCameraChange, onSceneApplied]);

  useEffect(() => {
    if (sceneRecipe) schedulerRef.current?.schedule(sceneRecipe);
  }, [sceneRecipe]);

  useEffect(() => {
    if (!burst?.perspectives.length) return;
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    const delay = Math.max(0, burst.revealAtServerMs - clock.serverNow());
    burstTimerRef.current = setTimeout(() => {
      setActiveBurst(burst);
      burstTimerRef.current = null;
    }, delay);
    return () => {
      if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
      burstTimerRef.current = null;
    };
  }, [burst, clock]);

  const activeSources = useMemo(() => {
    if (!appliedScene) return [];
    return appliedScene.activeCameraIds
      .map((id) => cameras.find((camera) => camera.id === id))
      .filter((camera): camera is ProgramCameraSource => Boolean(camera));
  }, [appliedScene, cameras]);

  const completeBurst = () => {
    const burstId = activeBurst?.id;
    setActiveBurst(null);
    if (burstId) onBurstComplete?.(burstId);
    onForegroundCameraChange?.(appliedScene?.activeCameraIds[0] ?? null);
  };

  let scene: ReactNode;
  if (!appliedScene || !activeSources.length) {
    scene = (
      <div className={styles.waitingScene} role="status">
        <span className={styles.waitingPulse} aria-hidden="true" />
        <p>SCAN TO BECOME A CAMERA IN THIS FILM</p>
        <small>Waiting for the first real angle</small>
      </div>
    );
  } else if (appliedScene.layout === "duo" && activeSources.length > 1) {
    scene = <DuoScene primary={activeSources[0]} secondary={activeSources[1]} />;
  } else if (appliedScene.layout === "sweep" && activeSources.length > 1) {
    scene = (
      <SweepScene
        sources={activeSources}
        intervalMs={
          appliedScene.durationMs
            ? Math.floor(appliedScene.durationMs / activeSources.length)
            : undefined
        }
        onForegroundCameraChange={onForegroundCameraChange}
      />
    );
  } else {
    scene = <HeroScene source={activeSources[0]} />;
  }

  return (
    <section className={styles.program} aria-label="ManyVue live program">
      <div className={styles.scene}>{scene}</div>
      {activeBurst && (
        <CrowdBurstReveal
          key={activeBurst.id}
          burst={activeBurst}
          onForegroundCameraChange={onForegroundCameraChange}
          onComplete={completeBurst}
        />
      )}

      <header className={styles.programHeader}>
        <div>
          <span>{eyebrow}</span>
          <strong>{title}</strong>
        </div>
        <div className={styles.onAir}>
          <span aria-hidden="true" />
          ON AIR
        </div>
      </header>

      {qrSlot && (
        <aside className={styles.qrSlot} aria-label="Join ManyVue">
          <div>{qrSlot}</div>
          <span>SCAN · JOIN THE FILM</span>
        </aside>
      )}

      <footer className={styles.programFooter}>
        <span>{cameras.filter((camera) => camera.connected).length} LIVE ANGLES</span>
        {appliedScene && showDiagnostics && (
          <span>
            {appliedScene.layout.toUpperCase()} · CUT {Math.round(appliedScene.latenessMs)}MS
          </span>
        )}
      </footer>
    </section>
  );
}
