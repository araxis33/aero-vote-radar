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
    currentValuePerVote: 0.2,
    predictedValuePerVote: 0.24,
    predictiveEdge: 0.2,
    volatility: 0.5,
    consistency: 2 / 3,
    ...rest,
  };
}

test("toSnapshotPool publishes the allocator's inputs, not just the derived per-vote figures", () => {
  const p = toSnapshotPool(ranked({}));
  // The browser re-runs allocateAcrossCandidates, which needs both of these;
  // the CLI's JSON shape carries neither.
  assert.equal(p.votesVeAero, 500);
  assert.equal(p.trailingAvgUsd, 120);
  assert.equal(p.symbol, "vAMM-TEST/USDC");
  assert.equal(p.pool, "0xpool");
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
