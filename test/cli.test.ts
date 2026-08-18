import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveIntFlag, parseUnitIntervalFlag, poolEfficiencyToJson, veAeroPositionsToJson } from "../src/cli.js";
import { EPOCH_SECONDS } from "../src/trend.js";
import type { PoolEfficiency } from "../src/efficiency.js";
import type { VeNftSummary } from "../src/veAero.js";

test("parsePositiveIntFlag returns the fallback when the flag is absent", () => {
  assert.equal(parsePositiveIntFlag([], "top", 20), 20);
});

test("parsePositiveIntFlag parses a valid positive integer flag", () => {
  assert.equal(parsePositiveIntFlag(["--top", "5"], "top", 20), 5);
});

test("parsePositiveIntFlag rejects a non-numeric value instead of returning NaN", () => {
  assert.equal(parsePositiveIntFlag(["--top", "abc"], "top", 20), undefined);
});

test("parsePositiveIntFlag rejects zero and negative values", () => {
  assert.equal(parsePositiveIntFlag(["--top", "0"], "top", 20), undefined);
  assert.equal(parsePositiveIntFlag(["--top", "-5"], "top", 20), undefined);
});

test("parsePositiveIntFlag rejects non-integer values", () => {
  assert.equal(parsePositiveIntFlag(["--top", "3.5"], "top", 20), undefined);
});

test("parsePositiveIntFlag rejects a dangling flag with no value instead of silently using the fallback", () => {
  assert.equal(parsePositiveIntFlag(["--top"], "top", 20), undefined);
  assert.equal(parsePositiveIntFlag(["--veaero", "25000", "--top"], "top", 20), undefined);
});

test("parsePositiveIntFlag accepts a value at or below the given max", () => {
  assert.equal(parsePositiveIntFlag(["--epochs", "20"], "epochs", 6, 20), 20);
  assert.equal(parsePositiveIntFlag(["--epochs", "6"], "epochs", 6, 20), 6);
});

test("parsePositiveIntFlag rejects a value above the given max instead of silently clamping it", () => {
  assert.equal(parsePositiveIntFlag(["--epochs", "21"], "epochs", 6, 20), undefined);
  assert.equal(parsePositiveIntFlag(["--epochs", "100000"], "epochs", 6, 20), undefined);
});

test("parsePositiveIntFlag ignores max when the flag is absent, still returning the fallback", () => {
  assert.equal(parsePositiveIntFlag([], "epochs", 6, 20), 6);
});

test("parseUnitIntervalFlag returns the fallback when the flag is absent", () => {
  assert.equal(parseUnitIntervalFlag([], "min-consistency", 0), 0);
});

test("parseUnitIntervalFlag accepts both ends of the 0..1 range and a fraction inside it", () => {
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "0"], "min-consistency", 0), 0);
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "1"], "min-consistency", 0), 1);
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "0.55"], "min-consistency", 0), 0.55);
});

test("parseUnitIntervalFlag rejects values outside 0..1 rather than silently clamping", () => {
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "-0.1"], "min-consistency", 0), undefined);
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "1.5"], "min-consistency", 0), undefined);
});

test("parseUnitIntervalFlag rejects non-numeric and dangling flags", () => {
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "abc"], "min-consistency", 0), undefined);
  assert.equal(parseUnitIntervalFlag(["--min-consistency"], "min-consistency", 0), undefined);
  assert.equal(parseUnitIntervalFlag(["--min-consistency", "Infinity"], "min-consistency", 0), undefined);
});

test("poolEfficiencyToJson includes epochsObserved and the consistency fields, matching the MCP list_pool_efficiency shape", () => {
  const p: PoolEfficiency = {
    pool: { address: "0xpool", symbol: "vAMM-TEST/USDC", token0: "0xtoken0", token1: "0xtoken1", gauge: "0xgauge", gaugeAlive: true },
    latestEpochTs: 100,
    currentVotesVeAero: 10,
    latestEpochUsd: 5,
    trailingAvgUsd: 4,
    epochsObserved: 3,
    epochUsdSeries: [5, 4, 3],
    currentValuePerVote: 0.5,
    predictedValuePerVote: 0.4,
    predictiveEdge: -0.2,
    volatility: 0.25,
    consistency: 0.8,
  };

  // Only 3 epochs observed — below MOMENTUM_MIN_EPOCHS, so momentum is null
  // regardless of the "as of" time passed in.
  assert.deepEqual(poolEfficiencyToJson(p, 1000), {
    symbol: "vAMM-TEST/USDC",
    pool: "0xpool",
    votesVeAero: 10,
    currentValuePerVote: 0.5,
    predictedValuePerVote: 0.4,
    predictiveEdge: -0.2,
    epochsObserved: 3,
    volatility: 0.25,
    consistency: 0.8,
    momentum: null,
  });
});

test("poolEfficiencyToJson wires momentum from the pool's epoch series and the given time, matching the MCP tool", () => {
  const p: PoolEfficiency = {
    pool: { address: "0xpool", symbol: "vAMM-TEST/USDC", token0: "0xtoken0", token1: "0xtoken1", gauge: "0xgauge", gaugeAlive: true },
    latestEpochTs: 1_786_579_200, // a Thursday 00:00 UTC epoch boundary
    currentVotesVeAero: 10,
    latestEpochUsd: 400,
    trailingAvgUsd: 250,
    epochsObserved: 4,
    epochUsdSeries: [400, 400, 100, 100],
    currentValuePerVote: 40,
    predictedValuePerVote: 25,
    predictiveEdge: -0.375,
    volatility: 0.6,
    consistency: 0.625,
  };

  // A full epoch after latestEpochTs: that epoch has closed, so all 4 entries
  // are completed history and momentum compares the recent half to the older half.
  const asOfUnixSeconds = p.latestEpochTs + EPOCH_SECONDS;
  assert.equal(poolEfficiencyToJson(p, asOfUnixSeconds).momentum, 3);
});

test("veAeroPositionsToJson sums voting power across locks and matches the MCP get_my_veaero shape", () => {
  const positions: VeNftSummary[] = [
    { id: "6", votingPowerVeAero: 11_362_738.622, expiresAt: 0, isPermanent: true },
    { id: "17324", votingPowerVeAero: 107_871.726, expiresAt: 1_893_456_000, isPermanent: false },
  ];

  assert.deepEqual(veAeroPositionsToJson("0xAccount", positions), {
    address: "0xAccount",
    totalVeAero: 11_362_738.622 + 107_871.726,
    locks: positions,
  });
});

test("veAeroPositionsToJson returns a zero total and empty locks for an account with no veAERO", () => {
  assert.deepEqual(veAeroPositionsToJson("0xEmpty", []), {
    address: "0xEmpty",
    totalVeAero: 0,
    locks: [],
  });
});
