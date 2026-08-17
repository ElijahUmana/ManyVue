export type BurstDisplayPhase = "idle" | "capturing" | "preview" | "preserved";

export function burstDisplayState(input: {
  hasBurst: boolean;
  phase: BurstDisplayPhase;
  readyCount: number;
  expectedCount: number;
}) {
  const expectedCount = Math.max(1, Math.floor(input.expectedCount));
  const readyCount = Math.max(0, Math.min(expectedCount, Math.floor(input.readyCount)));
  const complete = input.hasBurst && readyCount >= expectedCount;
  const collecting = input.hasBurst && !complete && input.phase !== "idle";
  return { readyCount, expectedCount, complete, collecting };
}
