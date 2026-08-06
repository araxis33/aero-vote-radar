import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendAllocation, toWholePercentWeights } from "../src/allocator.js";
import type { AllocationResult } from "../src/allocator.js";
import type { PoolEfficiency } from "../src/efficiency.js";

function fixture(overrides: Partial<PoolEfficiency> & { address: string; symbol: string }): PoolEfficiency {
  return {
    pool: {
      address: overrides.address,
      symbol: overrides.symbol,
      token0: "0xtoken0",
      token1: "0xtoken1",
      gauge: "0xgauge",
      gaugeAlive: true,
    },
    latestEpochTs: 0,
    currentVotesVeAero: 0,
    latestEpochUsd: 0,
    trailingAvgUsd: 0,
    epochsObserved: 6,
    currentValuePerVote: 0,
    predictedValuePerVote: 0,
    predictiveEdge: 0,
    volatility: 0,
    consistency: 1,
    ...overrides,
  };
}

function alloc(symbol: string, weight: number): AllocationResult {
  return { pool: `0x${symbol}`, symbol, weight, veAeroAllocated: weight * 1000, expectedUsd: 0 };
}

test("zero budget returns no allocation", () => {
  const ranked = [fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 100 })];
  assert.deepEqual(recommendAllocation(ranked, 0), []);
});

test("a single candidate receives the entire budget", () => {
  const ranked = [fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 100 })];
  const result = recommendAllocation(ranked, 5000);

  assert.equal(result.length, 1);
  assert.equal(result[0].pool, "0xA");
  assert.ok(Math.abs(result[0].weight - 1) < 1e-6, `weight should be ~1, got ${result[0].weight}`);
  assert.ok(Math.abs(result[0].veAeroAllocated - 5000) < 1, "should allocate ~the full budget");
});

test("allocated veAERO and weights sum back to the requested budget", () => {
  const ranked = [
    fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 500 }),
    fixture({ address: "0xB", symbol: "B", currentVotesVeAero: 4000, trailingAvgUsd: 300 }),
    fixture({ address: "0xC", symbol: "C", currentVotesVeAero: 200, trailingAvgUsd: 50 }),
  ];
  const budget = 25_000;
  const result = recommendAllocation(ranked, budget);

  const totalAllocated = result.reduce((sum, r) => sum + r.veAeroAllocated, 0);
  const totalWeight = result.reduce((sum, r) => sum + r.weight, 0);

  assert.ok(Math.abs(totalAllocated - budget) < budget * 0.01, `total allocated (${totalAllocated}) should be ~= budget`);
  assert.ok(Math.abs(totalWeight - 1) < 0.01, `weights (${totalWeight}) should sum to ~1`);
});

test("self-dilution: two pools with identical incentives but a large enough budget get diversified, not dumped into one", () => {
  // Same trailing USD value, same existing votes -> perfectly symmetric, so a
  // budget much larger than either pool's own votes should split roughly evenly
  // instead of an APR-only optimizer's "put it all in pool A" answer.
  const ranked = [
    fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 100 }),
    fixture({ address: "0xB", symbol: "B", currentVotesVeAero: 1000, trailingAvgUsd: 100 }),
  ];
  const result = recommendAllocation(ranked, 50_000);

  assert.equal(result.length, 2, "budget large relative to existing votes should spread across both pools");
  const [first, second] = result;
  assert.ok(Math.abs(first.veAeroAllocated - second.veAeroAllocated) < 50_000 * 0.05, "symmetric pools should get near-equal allocation");
});

test("under-voted pool with equal incentive is prioritized first for a small budget", () => {
  // Pool A has the same expected epoch value as B but far fewer existing votes,
  // so its marginal $-per-vote at the margin starts higher -> should be filled first.
  const ranked = [
    fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 100, trailingAvgUsd: 100 }),
    fixture({ address: "0xB", symbol: "B", currentVotesVeAero: 100_000, trailingAvgUsd: 100 }),
  ];
  const result = recommendAllocation(ranked, 10); // tiny budget relative to either pool

  assert.equal(result.length, 1);
  assert.equal(result[0].pool, "0xA");
});

test("a non-finite budget (Infinity/NaN) returns no allocation instead of NaN weights", () => {
  const ranked = [fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 100 })];
  assert.deepEqual(recommendAllocation(ranked, Infinity), []);
  assert.deepEqual(recommendAllocation(ranked, NaN), []);
  assert.deepEqual(recommendAllocation(ranked, -Infinity), []);
});

test("toWholePercentWeights: six equal weights sum to exactly 100, not 102", () => {
  // Rounding 16.666% independently gives 17% six times = 102%, which Aerodrome's
  // voting UI rejects. Largest-remainder must land on exactly 100.
  const result = toWholePercentWeights(Array.from({ length: 6 }, (_, i) => alloc(`P${i}`, 1 / 6)));

  assert.equal(result.length, 6);
  assert.equal(result.reduce((a, b) => a + b.percent, 0), 100);
  // Floors are 16 each = 96, so four leftover points are handed out: 4x17 + 2x16.
  assert.deepEqual(
    result.map((r) => r.percent).sort((a, b) => a - b),
    [16, 16, 17, 17, 17, 17],
  );
});

test("toWholePercentWeights: three equal thirds sum to exactly 100", () => {
  const result = toWholePercentWeights([alloc("A", 1 / 3), alloc("B", 1 / 3), alloc("C", 1 / 3)]);
  assert.equal(result.reduce((a, b) => a + b.percent, 0), 100);
  assert.deepEqual(result.map((r) => r.percent).sort((a, b) => a - b), [33, 33, 34]);
});

test("toWholePercentWeights: leftover points go to the largest fractional remainders", () => {
  // Raw: 50.4 / 30.3 / 19.3 -> floors 50/30/19 = 99, one point left over, and
  // A holds the biggest remainder (.4) so it takes it.
  const result = toWholePercentWeights([alloc("A", 0.504), alloc("B", 0.303), alloc("C", 0.193)]);

  assert.equal(result.reduce((a, b) => a + b.percent, 0), 100);
  assert.deepEqual(result, [
    { pool: "0xA", symbol: "A", percent: 51 },
    { pool: "0xB", symbol: "B", percent: 30 },
    { pool: "0xC", symbol: "C", percent: 19 },
  ]);
});

test("toWholePercentWeights: drops rows that round to 0% while still totalling 100", () => {
  const result = toWholePercentWeights([alloc("A", 0.996), alloc("B", 0.004)]);

  assert.equal(result.reduce((a, b) => a + b.percent, 0), 100);
  assert.deepEqual(result, [{ pool: "0xA", symbol: "A", percent: 100 }]);
});

test("toWholePercentWeights: normalises weights that carry floating-point drift", () => {
  // Weights that sum to 0.999... rather than exactly 1 must still produce 100.
  const drifting = [alloc("A", 0.3333), alloc("B", 0.3333), alloc("C", 0.3333)];
  assert.equal(toWholePercentWeights(drifting).reduce((a, b) => a + b.percent, 0), 100);
});

test("toWholePercentWeights: an empty or zero-weight allocation returns nothing", () => {
  assert.deepEqual(toWholePercentWeights([]), []);
  assert.deepEqual(toWholePercentWeights([alloc("A", 0)]), []);
});

test("toWholePercentWeights: a real recommendAllocation result always totals 100", () => {
  const ranked = [
    fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 500 }),
    fixture({ address: "0xB", symbol: "B", currentVotesVeAero: 4000, trailingAvgUsd: 300 }),
    fixture({ address: "0xC", symbol: "C", currentVotesVeAero: 200, trailingAvgUsd: 50 }),
  ];
  const percents = toWholePercentWeights(recommendAllocation(ranked, 25_000));

  assert.ok(percents.length > 0);
  assert.equal(percents.reduce((a, b) => a + b.percent, 0), 100);
  assert.ok(percents.every((p) => Number.isInteger(p.percent) && p.percent > 0));
});

test("only the top K ranked candidates are ever considered", () => {
  // recommendAllocation trusts the caller's ranking order and just slices the
  // first topK — so the array order here *is* the rank order (best pool first).
  const ranked = [
    fixture({ address: "0xA", symbol: "A", currentVotesVeAero: 1000, trailingAvgUsd: 50 }),
    fixture({ address: "0xLOW", symbol: "LOW", currentVotesVeAero: 10, trailingAvgUsd: 1000 }), // would be very attractive, but ranked below the cutoff
  ];
  const result = recommendAllocation(ranked, 1000, /* topK */ 1);

  assert.equal(result.length, 1);
  assert.equal(result[0].pool, "0xA", "candidate beyond topK must be excluded even if it would be more attractive");
});
