import type {
  LiveKitConnectOptions,
  LiveMediaAdapter,
  LiveMediaStatusListener,
} from "./livekit-adapter";

export interface ReconnectCoordinatorOptions {
  initialDelayMs?: number;
  maximumDelayMs?: number;
  maximumAttempts?: number;
}

/**
 * Coordinates browser offline/online recovery around the LiveKit SDK's own
 * reconnect behavior. Local MediaRecorder operation is deliberately separate,
 * so a failed uplink never stops the owner's original recording.
 */
export class LiveMediaReconnectCoordinator {
  private attempt = 0;
  private retryTimer: number | null = null;
  private running = false;
  private connectOptions: LiveKitConnectOptions | null = null;
  private camera: { stream: MediaStream; cameraId: string } | null = null;
  private removeStatusListener: (() => void) | null = null;
  private readonly initialDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly maximumAttempts: number;

  constructor(
    private readonly adapter: LiveMediaAdapter,
    options: ReconnectCoordinatorOptions = {},
  ) {
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.maximumDelayMs = options.maximumDelayMs ?? 8_000;
    this.maximumAttempts = options.maximumAttempts ?? 8;
  }

  async start(
    connectOptions: LiveKitConnectOptions,
    camera?: { stream: MediaStream; cameraId: string },
  ): Promise<void> {
    this.connectOptions = connectOptions;
    this.camera = camera ?? null;
    this.running = true;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    this.removeStatusListener = this.adapter.onStatus(this.handleStatus);
    await this.connectAndPublish();
  }

  setCamera(stream: MediaStream, cameraId: string): void {
    this.camera = { stream, cameraId };
    if (this.adapter.status === "connected") {
      void this.adapter.publishCamera(stream, cameraId).catch(() => this.scheduleRetry());
    }
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.removeStatusListener?.();
    this.removeStatusListener = null;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
  }

  private readonly handleOnline = (): void => {
    this.attempt = 0;
    this.scheduleRetry(0);
  };

  private readonly handleOffline = (): void => {
    this.clearTimer();
  };

  private readonly handleStatus: LiveMediaStatusListener = (status): void => {
    if (status === "connected") {
      this.attempt = 0;
      this.clearTimer();
    } else if ((status === "disconnected" || status === "failed") && navigator.onLine) {
      this.scheduleRetry();
    }
  };

  private scheduleRetry(delayOverride?: number): void {
    if (
      !this.running ||
      !navigator.onLine ||
      this.retryTimer !== null ||
      this.attempt >= this.maximumAttempts
    ) {
      return;
    }
    const delay =
      delayOverride ??
      Math.min(this.maximumDelayMs, this.initialDelayMs * 2 ** this.attempt);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.attempt += 1;
      void this.connectAndPublish().catch(() => this.scheduleRetry());
    }, delay);
  }

  private async connectAndPublish(): Promise<void> {
    if (!this.connectOptions || !this.running || !navigator.onLine) return;
    await this.adapter.connect(this.connectOptions);
    if (this.camera) {
      await this.adapter.publishCamera(this.camera.stream, this.camera.cameraId);
    }
  }

  private clearTimer(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
