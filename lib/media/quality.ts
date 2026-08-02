import type { CameraQualityScore } from "./types";

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 54;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class CameraQualityAnalyzer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private previousLuma: Float32Array | null = null;
  private frozenFrames = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = SAMPLE_WIDTH;
    this.canvas.height = SAMPLE_HEIGHT;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas pixel analysis is unavailable in this browser.");
    this.context = context;
  }

  analyze(video: HTMLVideoElement): CameraQualityScore {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
      throw new Error("A playable video frame is required for camera quality analysis.");
    }

    this.context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const pixels = this.context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
    const luma = new Float32Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
    let sum = 0;
    let sumSquares = 0;

    for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index += 1) {
      const value =
        (0.2126 * pixels[pixel] +
          0.7152 * pixels[pixel + 1] +
          0.0722 * pixels[pixel + 2]) /
        255;
      luma[index] = value;
      sum += value;
      sumSquares += value * value;
    }

    const brightness = sum / luma.length;
    const contrast = Math.sqrt(Math.max(0, sumSquares / luma.length - brightness ** 2));
    let gradient = 0;
    let gradientSamples = 0;
    for (let y = 1; y < SAMPLE_HEIGHT; y += 1) {
      for (let x = 1; x < SAMPLE_WIDTH; x += 1) {
        const index = y * SAMPLE_WIDTH + x;
        gradient +=
          Math.abs(luma[index] - luma[index - 1]) +
          Math.abs(luma[index] - luma[index - SAMPLE_WIDTH]);
        gradientSamples += 2;
      }
    }
    const sharpness = clamp((gradient / Math.max(1, gradientSamples)) * 8);

    let motion = 1;
    if (this.previousLuma) {
      let difference = 0;
      for (let index = 0; index < luma.length; index += 1) {
        difference += Math.abs(luma[index] - this.previousLuma[index]);
      }
      motion = difference / luma.length;
      this.frozenFrames = motion < 0.0015 ? this.frozenFrames + 1 : 0;
    }
    this.previousLuma = luma;

    const dark = brightness < 0.08;
    const covered = brightness < 0.14 && contrast < 0.035;
    const blurred = sharpness < 0.12;
    const frozen = this.frozenFrames >= 5;
    const excessiveMotion = motion > 0.28;
    const reasons: CameraQualityScore["reasons"] = [];
    if (dark) reasons.push("dark");
    if (covered) reasons.push("covered");
    if (blurred) reasons.push("blurred");
    if (frozen) reasons.push("frozen");
    if (excessiveMotion) reasons.push("excessive-motion");
    if (!reasons.length) reasons.push("healthy");

    const exposureScore = 1 - Math.min(1, Math.abs(brightness - 0.48) / 0.48);
    const stabilityScore = excessiveMotion ? clamp(1 - (motion - 0.28) * 2.5) : 1;
    const score = Math.round(
      100 *
        clamp(
          exposureScore * 0.25 +
            clamp(contrast * 4) * 0.2 +
            sharpness * 0.35 +
            stabilityScore * 0.2 -
            (frozen ? 0.7 : 0) -
            (covered ? 0.7 : 0),
        ),
    );

    return {
      score,
      usable: !dark && !covered && !frozen && score >= 35,
      reasons,
      metrics: {
        brightness,
        contrast,
        sharpness,
        motion,
        frozenFrames: this.frozenFrames,
        sampledAtMs: Date.now(),
      },
      fingerprint: this.fingerprint(luma, brightness),
    };
  }

  reset(): void {
    this.previousLuma = null;
    this.frozenFrames = 0;
  }

  private fingerprint(luma: Float32Array, mean: number): Uint8Array {
    const bits = new Uint8Array(64);
    for (let cellY = 0; cellY < 8; cellY += 1) {
      for (let cellX = 0; cellX < 8; cellX += 1) {
        const sampleX = Math.floor(((cellX + 0.5) / 8) * SAMPLE_WIDTH);
        const sampleY = Math.floor(((cellY + 0.5) / 8) * SAMPLE_HEIGHT);
        bits[cellY * 8 + cellX] = luma[sampleY * SAMPLE_WIDTH + sampleX] >= mean ? 1 : 0;
      }
    }
    return bits;
  }
}

export function fingerprintDistance(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length || !left.length) return 1;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) different += 1;
  }
  return different / left.length;
}

export function areVisuallyDuplicate(
  left: CameraQualityScore,
  right: CameraQualityScore,
  maximumDistance = 0.08,
): boolean {
  return fingerprintDistance(left.fingerprint, right.fingerprint) <= maximumDistance;
}
