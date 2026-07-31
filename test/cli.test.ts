import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCliError, parsePositiveIntFlag, poolEfficiencyToJson, veAeroPositionsToJson } from "../src/cli.js";
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

test("formatCliError prefers a viem-style shortMessage over the full multi-paragraph message", () => {
  const err = new Error(
    "HTTP request failed.\n\nDocs: https://viem.sh/docs/x\nDetails: over rate limit\n\nVersion: viem@2.55.2",
  );
  (err as Error & { shortMessage: string }).shortMessage = "HTTP request failed.";
  assert.equal(formatCliError(err), "HTTP request failed.");
});

test("formatCliError falls back to the plain message for a regular Error with no shortMessage", () => {
  assert.equal(formatCliError(new Error("boom")), "boom");
});

test("formatCliError stringifies a non-Error thrown value", () => {
  assert.equal(formatCliError("plain string throw"), "plain string throw");
});
