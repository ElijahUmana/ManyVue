import assert from "node:assert/strict";
import test from "node:test";
import {
  expireStalePresence,
  type ExpirableConnectionState,
} from "../../convex/lib/presence_expiry";

type Participant = {
  id: number;
  connectionState: "online" | "degraded" | "offline";
  lastSeenAt: number;
  disconnectedAt?: number;
};

function memoryStore(rows: Participant[], queriedStates: ExpirableConnectionState[]) {
  return {
    findStaleByState: async (
      state: ExpirableConnectionState,
      cutoffMs: number,
      limit: number,
    ) => {
      queriedStates.push(state);
      return rows
        .filter((row) => row.connectionState === state && row.lastSeenAt < cutoffMs)
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
        .slice(0, limit);
    },
    markOffline: async (participant: Participant, disconnectedAtMs: number) => {
      participant.connectionState = "offline";
      participant.disconnectedAt = disconnectedAtMs;
    },
  };
}

test("more than 100 old offline rows cannot starve stale connected cameras", async () => {
  const rows: Participant[] = Array.from({ length: 150 }, (_, id) => ({
    id,
    connectionState: "offline",
    lastSeenAt: id,
  }));
  rows.push(
    { id: 201, connectionState: "online", lastSeenAt: 100 },
    { id: 202, connectionState: "online", lastSeenAt: 200 },
    { id: 203, connectionState: "degraded", lastSeenAt: 300 },
    { id: 204, connectionState: "online", lastSeenAt: 10_001 },
  );
  const queriedStates: ExpirableConnectionState[] = [];

  const result = await expireStalePresence({
    store: memoryStore(rows, queriedStates),
    cutoffMs: 10_000,
    disconnectedAtMs: 12_345,
    batchSize: 100,
  });

  assert.deepEqual(queriedStates, ["online", "degraded"]);
  assert.deepEqual(result, { expired: 3, scanned: 3 });
  assert.equal(rows.find((row) => row.id === 201)?.connectionState, "offline");
  assert.equal(rows.find((row) => row.id === 202)?.connectionState, "offline");
  assert.equal(rows.find((row) => row.id === 203)?.connectionState, "offline");
  assert.equal(rows.find((row) => row.id === 204)?.connectionState, "online");

  const second = await expireStalePresence({
    store: memoryStore(rows, []),
    cutoffMs: 10_000,
    disconnectedAtMs: 20_000,
    batchSize: 100,
  });
  assert.deepEqual(second, { expired: 0, scanned: 0 });
});

test("bounded batches drain without rereading participants already expired", async () => {
  const rows: Participant[] = Array.from({ length: 101 }, (_, id) => ({
    id,
    connectionState: "online",
    lastSeenAt: id,
  }));

  const first = await expireStalePresence({
    store: memoryStore(rows, []),
    cutoffMs: 10_000,
    disconnectedAtMs: 20_000,
    batchSize: 100,
  });
  const second = await expireStalePresence({
    store: memoryStore(rows, []),
    cutoffMs: 10_000,
    disconnectedAtMs: 30_000,
    batchSize: 100,
  });
  const third = await expireStalePresence({
    store: memoryStore(rows, []),
    cutoffMs: 10_000,
    disconnectedAtMs: 40_000,
    batchSize: 100,
  });

  assert.deepEqual(first, { expired: 100, scanned: 100 });
  assert.deepEqual(second, { expired: 1, scanned: 1 });
  assert.deepEqual(third, { expired: 0, scanned: 0 });
});
