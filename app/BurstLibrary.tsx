"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listBurstAssets, type ListedMediaAsset } from "@/lib/artifacts/burst-upload";

export type BurstLibraryEntry = {
  id: string;
  at: number;
  expectedCount: number;
  readyCount: number;
  status?: string;
};

type BurstSource = {
  participantId: string;
  asset: ListedMediaAsset;
  durationMs: number;
  burstOffsetMs: number;
};

const WINDOW_RADIUS_SECONDS = 3;

function asBurstSource(asset: ListedMediaAsset): BurstSource | null {
  if (asset.metadata.kind !== "burst-source" || !asset.metadata.participant) return null;
  const durationMs = Number(asset.metadata.durationMs);
  const burstOffsetMs = Number(asset.metadata.burstOffsetMs);
  if (!Number.isFinite(durationMs) || !Number.isFinite(burstOffsetMs)) return null;
  return { participantId: asset.metadata.participant, asset, durationMs, burstOffsetMs };
}

function clockLabel(epochMs: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(epochMs));
}

function BurstReplay({
  source,
  anchor,
  playToken,
}: {
  source: BurstSource;
  anchor: "mine" | "host" | "lead" | false;
  playToken: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const expectedDurationSeconds = Math.max(0.1, source.durationMs / 1_000);
  const startSeconds = Math.max(0, source.burstOffsetMs / 1_000 - WINDOW_RADIUS_SECONDS);
  const endSeconds = Math.min(
    expectedDurationSeconds,
    source.burstOffsetMs / 1_000 + WINDOW_RADIUS_SECONDS,
  );

  const playWindow = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.min(startSeconds, Math.max(0, video.duration || expectedDurationSeconds));
    setPlaying(true);
    void video.play().catch(() => setPlaying(false));
  }, [expectedDurationSeconds, startSeconds]);

  useEffect(() => {
    if (!playToken || !ready) return;
    playWindow();
  }, [playToken, playWindow, ready]);

  return (
    <article className={`burst-replay ${anchor ? "owner" : "crowd"}`}>
      <div className="burst-replay-frame">
        <video
          ref={videoRef}
          src={source.asset.url}
          playsInline
          preload="metadata"
          muted={!anchor}
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = Math.min(startSeconds, Math.max(0, event.currentTarget.duration));
            setReady(true);
          }}
          onTimeUpdate={(event) => {
            if (playing && event.currentTarget.currentTime >= endSeconds - 0.04) {
              event.currentTarget.pause();
              event.currentTarget.currentTime = startSeconds;
              setPlaying(false);
            }
          }}
          onEnded={() => setPlaying(false)}
        />
        <div className="burst-replay-window" aria-hidden="true">
          <span>T−3</span><i /><b>BURST</b><i /><span>T+3</span>
        </div>
        <button type="button" className="burst-replay-play" onClick={playWindow}>
          {playing ? "REPLAYING 6 SECONDS" : ready ? "REPLAY THIS ANGLE" : "LOADING ANGLE…"}
        </button>
      </div>
      <div className="burst-replay-meta">
        <div>
          <p>{anchor === "mine" ? "MY ANGLE · ANCHOR" : anchor === "host" ? "HOST ANGLE · ANCHOR" : anchor === "lead" ? "LEAD SAVED ANGLE" : "CROWD ANGLE"}</p>
          <b>{anchor === "mine" ? "The moment from where I stood" : anchor === "host" ? "The published laptop camera" : anchor === "lead" ? "First available synchronized perspective" : `CAM ${source.participantId.slice(-4).toUpperCase()}`}</b>
        </div>
        <a href={source.asset.url} download={`crowdcut-burst-${source.participantId}.webm`}>
          DOWNLOAD
        </a>
      </div>
    </article>
  );
}

export function BurstLibrary({
  open,
  sessionId,
  ownerParticipantId,
  bursts,
  programView = false,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  ownerParticipantId: string;
  bursts: BurstLibraryEntry[];
  programView?: boolean;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [assets, setAssets] = useState<ListedMediaAsset[]>([]);
  const [loadedBurstId, setLoadedBurstId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [playToken, setPlayToken] = useState(0);

  const activeId = selectedId || bursts[0]?.id || "";
  const selected = bursts.find((entry) => entry.id === activeId) ?? bursts[0];
  const selectedBurstId = selected?.id ?? "";
  const selectedExpectedCount = selected?.expectedCount ?? 0;

  const load = useCallback(async () => {
    if (!open || !selectedBurstId) return;
    setLoading(true);
    setMessage("");
    try {
      setAssets(await listBurstAssets(sessionId, selectedBurstId));
      setLoadedBurstId(selectedBurstId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The saved Burst angles could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [open, selectedBurstId, sessionId]);

  useEffect(() => {
    if (!open || !selectedBurstId) return;
    let cancelled = false;
    void listBurstAssets(sessionId, selectedBurstId).then((next) => {
      if (!cancelled) {
        setAssets(next);
        setLoadedBurstId(selectedBurstId);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "The saved Burst angles could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [open, selectedBurstId, sessionId]);

  const sources = useMemo(() => {
    if (loadedBurstId !== selectedBurstId) return [];
    const perParticipant = new Map<string, BurstSource>();
    for (const asset of assets) {
      const source = asBurstSource(asset);
      if (source) perParticipant.set(source.participantId, source);
    }
    return [...perParticipant.values()].sort((left, right) => {
      if (left.participantId === ownerParticipantId) return -1;
      if (right.participantId === ownerParticipantId) return 1;
      return left.participantId.localeCompare(right.participantId);
    });
  }, [assets, loadedBurstId, ownerParticipantId, selectedBurstId]);

  useEffect(() => {
    if (!open || !selectedBurstId || sources.length >= selectedExpectedCount) return;
    const timer = window.setInterval(() => void load(), 2_400);
    return () => window.clearInterval(timer);
  }, [load, open, selectedBurstId, selectedExpectedCount, sources.length]);

  if (!open) return null;

  const exactOwner = sources.find((source) => source.participantId === ownerParticipantId);
  const owner = exactOwner ?? (programView ? sources[0] : undefined);
  const crowd = sources.filter((source) => source.participantId !== owner?.participantId);
  const missingAngleCount = Math.max(0, selectedExpectedCount - sources.length);

  return (
    <section className="burst-library" role="dialog" aria-modal="true" aria-label="Saved CrowdCut Bursts">
      <header className="burst-library-topbar">
        <div>
          <p className="eyebrow">SAVED SYNCHRONIZED MOMENTS</p>
          <h2>VIEW BURSTS</h2>
        </div>
        <button type="button" onClick={onClose}>{programView ? "BACK TO FILM" : "BACK TO CAMERA"} ×</button>
      </header>

      <nav className="burst-library-tabs" aria-label="Choose a saved Burst">
        {bursts.map((entry, index) => (
          <button
            type="button"
            key={entry.id}
            className={entry.id === selected?.id ? "selected" : ""}
            onClick={() => {
              setSelectedId(entry.id);
              setAssets([]);
              setLoadedBurstId("");
              setMessage("");
            }}
          >
            <span>BURST {String(bursts.length - index).padStart(2, "0")}</span>
            <b>{clockLabel(entry.at)}</b>
            <small>{entry.readyCount}/{entry.expectedCount} ANGLES READY</small>
          </button>
        ))}
      </nav>

      {!selected ? (
        <div className="burst-library-empty">
          <b>NO BURSTS YET</b>
          <p>Keep your camera rolling, then tap Burst to preserve three seconds before and after the moment.</p>
        </div>
      ) : (
        <div className="burst-library-content">
          <div className="burst-library-heading">
            <div>
              <p className="eyebrow">ONE MOMENT · EVERY REAL VIEW</p>
              <h3>{clockLabel(selected.at)}</h3>
              <span>Every clip replays the same six-second window: three seconds before the tap through three seconds after it.</span>
            </div>
            <div className="burst-library-actions">
              <button type="button" onClick={() => setPlayToken((value) => value + 1)} disabled={!sources.length}>
                PLAY ALL ANGLES
              </button>
              <button type="button" onClick={() => void load()} disabled={loading}>
                {loading ? "SYNCING…" : "REFRESH ANGLES"}
              </button>
            </div>
          </div>

          {message && <p className="burst-library-error">{message}</p>}
          {owner ? (
            <BurstReplay
              source={owner}
              anchor={programView ? (exactOwner ? "host" : "lead") : "mine"}
              playToken={playToken}
            />
          ) : (
            <div className="burst-owner-waiting">
              <i />
              <div><b>MY ANGLE IS BEING PRESERVED</b><span>The full recording continues while this six-second replay uploads.</span></div>
            </div>
          )}

          <div className="burst-crowd-heading">
            <div><b>EVERY OTHER ANGLE</b><span>{crowd.length} real crowd {crowd.length === 1 ? "view" : "views"} ready</span></div>
            <em>{sources.length}/{selected.expectedCount} SYNCED</em>
          </div>
          <div className="burst-crowd-grid">
            {crowd.map((source) => (
              <BurstReplay key={source.participantId} source={source} anchor={false} playToken={playToken} />
            ))}
            {!crowd.length && missingAngleCount > 0 && (
              <div className="burst-library-empty compact">
                <b>WAITING FOR THE CROWD</b>
                <p>{missingAngleCount} active {missingAngleCount === 1 ? "camera is" : "cameras are"} still uploading the matching T−3 to T+3 window.</p>
              </div>
            )}
            {!crowd.length && missingAngleCount === 0 && (
              <div className="burst-library-empty compact complete">
                <b>ALL ACTIVE ANGLES SAVED</b>
                <p>This Burst had one active camera. Nothing is missing from the synchronized replay.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
