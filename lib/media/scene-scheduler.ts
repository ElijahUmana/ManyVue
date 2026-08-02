import type { AppliedScene, SceneRecipe } from "./types";

interface ClockSample {
  offsetMs: number;
  roundTripMs: number;
}

/**
 * Estimates server epoch time using the lowest-latency round trips. This does
 * not claim frame accuracy; it provides a measured clock for coordinated cuts
 * and exposes actual lateness after every application.
 */
export class ServerClock {
  private samples: ClockSample[] = [];
  private offsetMs = 0;

  observe(serverEpochMs: number, requestSentAtMs: number, responseAtMs = Date.now()): void {
    const roundTripMs = Math.max(0, responseAtMs - requestSentAtMs);
    const localMidpointMs = requestSentAtMs + roundTripMs / 2;
    this.samples.push({ offsetMs: serverEpochMs - localMidpointMs, roundTripMs });
    this.samples = this.samples
      .sort((a, b) => a.roundTripMs - b.roundTripMs)
      .slice(0, 8);
    const best = this.samples.slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    this.offsetMs = best.reduce((sum, sample) => sum + sample.offsetMs, 0) / best.length;
  }

  serverNow(): number {
    return Date.now() + this.offsetMs;
  }

  serverToLocal(serverMs: number): number {
    return serverMs - this.offsetMs;
  }

  localToServer(localMs: number): number {
    return localMs + this.offsetMs;
  }

  get estimatedOffsetMs(): number {
    return this.offsetMs;
  }
}

export type SceneAppliedHandler = (scene: AppliedScene) => void;

export class SceneScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenRevision = -1;
  private lastAppliedRevision = -1;

  constructor(
    private readonly clock: ServerClock,
    private readonly apply: SceneAppliedHandler,
  ) {}

  schedule(recipe: SceneRecipe): boolean {
    if (recipe.revision <= this.lastSeenRevision) return false;
    if (!Number.isFinite(recipe.cutAtServerMs) || !recipe.activeCameraIds.length) {
      throw new Error("A scene requires a finite cut time and at least one active camera.");
    }
    this.lastSeenRevision = recipe.revision;
    this.cancelPending();
    const delayMs = Math.max(0, recipe.cutAtServerMs - this.clock.serverNow());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (recipe.revision <= this.lastAppliedRevision) return;
      const appliedAtLocalMs = Date.now();
      const estimatedServerMs = this.clock.localToServer(appliedAtLocalMs);
      this.lastAppliedRevision = recipe.revision;
      this.apply({
        ...recipe,
        appliedAtLocalMs,
        estimatedServerMs,
        latenessMs: estimatedServerMs - recipe.cutAtServerMs,
      });
    }, delayMs);
    return true;
  }

  cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.cancelPending();
    this.lastSeenRevision = -1;
    this.lastAppliedRevision = -1;
  }
}
