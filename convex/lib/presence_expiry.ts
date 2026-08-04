export const EXPIRABLE_CONNECTION_STATES = ["online", "degraded"] as const;

export type ExpirableConnectionState = (typeof EXPIRABLE_CONNECTION_STATES)[number];

type ExpirableParticipant = {
  connectionState: "online" | "degraded" | "offline";
  lastSeenAt: number;
};

export type PresenceExpiryStore<T extends ExpirableParticipant> = {
  findStaleByState: (
    state: ExpirableConnectionState,
    cutoffMs: number,
    limit: number,
  ) => Promise<T[]>;
  markOffline: (participant: T, disconnectedAtMs: number) => Promise<void>;
};

/**
 * Expire a bounded batch from each state that can still be live.
 *
 * Crucially, the store is queried by connection state before last-seen time.
 * Rows already marked offline therefore cannot occupy the batch or starve
 * stale online/degraded cameras behind them.
 */
export async function expireStalePresence<T extends ExpirableParticipant>(args: {
  store: PresenceExpiryStore<T>;
  cutoffMs: number;
  disconnectedAtMs: number;
  batchSize?: number;
}) {
  const batchSize = args.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("Presence expiry batch size must be a positive integer.");
  }

  let expired = 0;
  let scanned = 0;
  for (const state of EXPIRABLE_CONNECTION_STATES) {
    const stale = await args.store.findStaleByState(state, args.cutoffMs, batchSize);
    scanned += stale.length;
    for (const participant of stale) {
      // The index guarantees these conditions in production. Keep the guard
      // so the helper fails safe if it is ever reused with another store.
      if (participant.connectionState !== state || participant.lastSeenAt >= args.cutoffMs) continue;
      await args.store.markOffline(participant, args.disconnectedAtMs);
      expired += 1;
    }
  }
  return { expired, scanned };
}
