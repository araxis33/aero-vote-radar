import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveIntFlag, poolEfficiencyToJson } from "../src/cli.js";
import type { PoolEfficiency } from "../src/efficiency.js";

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

test("poolEfficiencyToJson includes epochsObserved, matching the MCP list_pool_efficiency shape", () => {
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
  };

  assert.deepEqual(poolEfficiencyToJson(p), {
    symbol: "vAMM-TEST/USDC",
    pool: "0xpool",
    votesVeAero: 10,
    currentValuePerVote: 0.5,
    predictedValuePerVote: 0.4,
    predictiveEdge: -0.2,
    epochsObserved: 3,
  });
});
