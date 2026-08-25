import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, toSnapshotPool } from "../src/snapshot.js";
import type { PoolEfficiency } from "../src/efficiency.js";

function ranked(overrides: Partial<PoolEfficiency> & { symbol?: string }): PoolEfficiency {
  const { symbol, ...rest } = overrides;
  return {
    pool: {
      address: "0xpool",
      symbol: symbol ?? "vAMM-TEST/USDC",
      token0: "0xtoken0",
      token1: "0xtoken1",
      gauge: "0xgauge",
      gaugeAlive: true,
    },
    latestEpochTs: 1_000,
    currentVotesVeAero: 500,
    latestEpochUsd: 100,
    trailingAvgUsd: 120,
    epochsObserved: 6,
    epochUsdSeries: [100, 110, 120, 130, 120, 140],
    currentValuePerVote: 0.2,
    predictedValuePerVote: 0.24,
    predictiveEdge: 0.2,
    volatility: 0.5,
    consistency: 2 / 3,
    ...rest,
  };
}

test("toSnapshotPool publishes the allocator's inputs, not just the derived per-vote figures", () => {
  const p = toSnapshotPool(ranked({}), new Date("2026-08-17T00:00:00Z"));
  // The browser re-runs allocateAcrossCandidates, which needs both of these;
  // the CLI's JSON shape carries neither.
  assert.equal(p.votesVeAero, 500);
  assert.equal(p.trailingAvgUsd, 120);
  assert.equal(p.symbol, "vAMM-TEST/USDC");
  assert.equal(p.pool, "0xpool");
});

test("toSnapshotPool publishes the epoch series and the pool's own epoch date", () => {
  const p = toSnapshotPool(
    ranked({ epochUsdSeries: [300, 200, 100, 100, 100, 100], latestEpochTs: 1_786_579_200 }),
    new Date("2026-08-17T00:00:00Z"),
  );
  assert.deepEqual(p.epochUsd, [300, 200, 100, 100, 100, 100]);
  assert.equal(p.latestEpochTs, 1_786_579_200);
});

test("toSnapshotPool flags a mid-week scan's newest epoch as partial and keeps it out of momentum", () => {
  // Epoch opened 2026-08-13, scanned four days later: epochUsd[0] is a part-week.
  const series = [60, 200, 200, 200, 200];
  const midWeek = toSnapshotPool(
    ranked({ epochUsdSeries: series, latestEpochTs: 1_786_579_200 }),
    new Date("2026-08-17T00:00:00Z"),
  );
  assert.equal(midWeek.currentEpochPartial, true);
  assert.equal(midWeek.momentum, 0); // the steady $200 epochs, part-week excluded

  // The same pool data a week on: that epoch has closed, so it now counts.
  const afterRollover = toSnapshotPool(
    ranked({ epochUsdSeries: series, latestEpochTs: 1_786_579_200 }),
    new Date("2026-08-24T00:00:00Z"),
  );
  assert.equal(afterRollover.currentEpochPartial, false);
  assert.ok((afterRollover.momentum as number) < -0.3);
});

test("buildSnapshot judges partial epochs against its own generatedAt, not the wall clock", () => {
  const snap = buildSnapshot(
    [ranked({ latestEpochTs: 1_786_579_200 })],
    new Date("2026-08-17T00:00:00Z"),
  );
  assert.equal(snap.pools[0].currentEpochPartial, true);
});

test("buildSnapshot records the generation time as an ISO string", () => {
  const snap = buildSnapshot([ranked({})], new Date("2026-08-07T12:00:00Z"));
  assert.equal(snap.generatedAt, "2026-08-07T12:00:00.000Z");
});

test("buildSnapshot counts the pools it publishes", () => {
  const snap = buildSnapshot([ranked({ symbol: "A" }), ranked({ symbol: "B" })], new Date());
  assert.equal(snap.poolCount, 2);
  assert.equal(snap.pools.length, 2);
});

test("buildSnapshot takes the newest epoch across pools, not the top-ranked pool's", () => {
  // Pools arrive sorted by predicted value, so the first pool can easily be one
  // whose rewards contract hasn't been touched this week. Taking its epoch would
  // report the site as staler than it is.
  const snap = buildSnapshot(
    [ranked({ symbol: "STALE", latestEpochTs: 1_000 }), ranked({ symbol: "FRESH", latestEpochTs: 9_000 })],
    new Date(),
  );
  assert.equal(snap.latestEpochTs, 9_000);
});

test("buildSnapshot on an empty ranking yields no pools and a zero epoch", () => {
  const snap = buildSnapshot([], new Date());
  assert.equal(snap.poolCount, 0);
  assert.equal(snap.latestEpochTs, 0);
});

test("the snapshot publishes when the epoch it describes stops being actionable", () => {
  // Scanned Saturday 2026-08-22 12:00 UTC, so the vote it recommends has to be
  // cast before Thursday 2026-08-27 00:00 UTC to count.
  const generatedAt = new Date(Date.UTC(2026, 7, 22, 12, 0, 0));
  const snapshot = buildSnapshot([ranked({ latestEpochTs: 1_786_320_000 })], generatedAt);

  assert.equal(new Date(snapshot.epochEndsAt * 1000).toISOString(), "2026-08-27T00:00:00.000Z");
  assert.ok(snapshot.epochEndsAt > Math.floor(generatedAt.getTime() / 1000));
});

test("epochEndsAt follows the scan clock, not a pool's stale latestEpochTs", () => {
  // A pool whose rewards contract has not been touched in weeks reports an old
  // epoch. Deriving the deadline from that would tell a visitor that voting
  // closed long ago, when the epoch they can actually vote in is the current one.
  const generatedAt = new Date(Date.UTC(2026, 7, 22, 12, 0, 0));
  const staleEpochTs = Math.floor(Date.UTC(2026, 6, 2, 0, 0, 0) / 1000);

  const snapshot = buildSnapshot([ranked({ latestEpochTs: staleEpochTs })], generatedAt);

  assert.equal(snapshot.latestEpochTs, staleEpochTs);
  assert.equal(new Date(snapshot.epochEndsAt * 1000).toISOString(), "2026-08-27T00:00:00.000Z");
});
