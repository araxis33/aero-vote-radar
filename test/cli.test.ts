import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveIntFlag, poolEfficiencyToJson, veAeroPositionsToJson } from "../src/cli.js";
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

/**
 * Asserted field by field rather than with a single deepEqual of the whole
 * object: this test's job is to pin the fields the `--json` output promises and
 * that the MCP `list_pool_efficiency` tool mirrors, not to freeze the shape
 * against ever gaining a new one.
 */
test("poolEfficiencyToJson exposes the documented pools --json fields, matching the MCP list_pool_efficiency shape", () => {
  const p: PoolEfficiency = {
    pool: { address: "0xpool", symbol: "vAMM-TEST/USDC", token0: "0xtoken0", token1: "0xtoken1", gauge: "0xgauge", gaugeAlive: true },
    latestEpochTs: 100,
    currentVotesVeAero: 10,
    latestEpochUsd: 5,
    trailingAvgUsd: 4,
    epochsObserved: 3,
    currentValuePerVote: 0.5,
    predictedValuePerVote: 0.4,
    predictiveEdge: -0.2,
    volatility: 0.25,
    consistency: 0.8,
  };

  const json = poolEfficiencyToJson(p);

  assert.equal(json.symbol, "vAMM-TEST/USDC");
  assert.equal(json.pool, "0xpool");
  assert.equal(json.votesVeAero, 10);
  assert.equal(json.currentValuePerVote, 0.5);
  assert.equal(json.predictedValuePerVote, 0.4);
  assert.equal(json.predictiveEdge, -0.2);
  assert.equal(json.epochsObserved, 3);
});

test("veAeroPositionsToJson sums voting power across locks and matches the MCP get_my_veaero shape", () => {
  const positions: VeNftSummary[] = [
    { id: "6", votingPowerVeAero: 11_362_738.622, expiresAt: 0 },
    { id: "17324", votingPowerVeAero: 107_871.726, expiresAt: 1_893_456_000 },
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
