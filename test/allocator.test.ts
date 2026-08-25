import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateAcrossCandidates,
  expectedUsdForWholePercentVote,
  recommendAllocation,
  toWholePercentWeights,
  unallocatedVeAero,
} from "../src/allocator.js";
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
    epochUsdSeries: [100, 110, 120, 130, 120, 140],
    currentValuePerVote: 0,
    predictedValuePerVote: 0,
    predictiveEdge: 0,
    volatility: 0,
    consistency: 1,
    ...overrides,
  };
}

function alloc(symbol: string, weight: number): AllocationResult {
  return {
    pool: `0x${symbol}`,
    symbol,
    weight,
    veAeroAllocated: weight * 1000,
    expectedUsd: 0,
    existingVotes: 0,
    poolExpectedUsd: 0,
  };
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

test("allocateAcrossCandidates funds a pool nobody else has voted on", () => {
  // V = 0 is the best case, not the worst: your share is R*x/(0+x) = R, the
  // whole epoch value. The marginal-value derivative R*V/(V+x)^2 is 0 there, so
  // before this was special-cased such a pool never received a single step no
  // matter how large R was — it was silently skipped in favour of any crowded
  // pool with a sliver of value left.
  const result = allocateAcrossCandidates(
    [
      { address: "0xEMPTY", symbol: "EMPTY", existingVotes: 0, expectedUsd: 500 },
      { address: "0xCROWDED", symbol: "CROWDED", existingVotes: 1_000_000, expectedUsd: 100 },
    ],
    1000,
  );

  const empty = result.find((r) => r.symbol === "EMPTY");
  assert.ok(empty, "the unvoted pool must receive an allocation");
  assert.ok(empty.veAeroAllocated > 0);
  // Holding all of the votes means collecting all of the value.
  assert.ok(Math.abs(empty.expectedUsd - 500) < 1e-6);
});

test("allocateAcrossCandidates gives an unvoted pool one slice, not the whole budget", () => {
  // The entire gain lands with the first slice — R*x/x is R whatever x is — so
  // piling more budget in adds nothing. The rest must stay available for pools
  // that can still pay for it.
  const result = allocateAcrossCandidates(
    [
      { address: "0xEMPTY", symbol: "EMPTY", existingVotes: 0, expectedUsd: 500 },
      { address: "0xREAL", symbol: "REAL", existingVotes: 1000, expectedUsd: 400 },
    ],
    1000,
    400,
  );

  const empty = result.find((r) => r.symbol === "EMPTY");
  const real = result.find((r) => r.symbol === "REAL");
  assert.ok(empty && real);
  // One step of a 1,000 veAERO budget over 400 steps.
  assert.ok(Math.abs(empty.veAeroAllocated - 2.5) < 1e-9);
  assert.ok(real.veAeroAllocated > empty.veAeroAllocated);
});

test("expectedUsdForWholePercentVote scores the rounded vote, not the continuous allocation", () => {
  // One pool, so the whole budget lands there and rounding changes nothing:
  // 100% of 1,000 veAERO against 1,000 existing votes collects half of $200.
  const allocation = allocateAcrossCandidates(
    [{ address: "0xA", symbol: "A", existingVotes: 1000, expectedUsd: 200 }],
    1000,
  );
  assert.ok(Math.abs(expectedUsdForWholePercentVote(allocation, 1000) - 100) < 1e-6);
});

test("expectedUsdForWholePercentVote counts the veAERO that dropped rows hand back", () => {
  // Fifteen pools on very different scales, allocated at a deliberately finer
  // granularity than a vote can express: several round to 0% and their points
  // are redistributed to the survivors, so those survivors end up with more
  // veAERO than the allocator penciled in. Summing `expectedUsd` over the kept
  // rows would miss that and understate the vote; summing over every row would
  // claim value from pools the user is told not to vote for.
  //
  // The default granularity no longer produces this situation at all (see the
  // test below), but the function still has to be right for a caller that asks
  // for finer steps, and for an allocation assembled by hand.
  const candidates = Array.from({ length: 15 }, (_, i) => ({
    address: `0x${i}`,
    symbol: `P${i}`,
    existingVotes: 10 ** (1 + (i % 5)),
    expectedUsd: 50 * (i + 1),
  }));
  const budget = 1_000_000;
  const allocation = allocateAcrossCandidates(candidates, budget, 400);
  const percents = toWholePercentWeights(allocation);

  assert.ok(percents.length < allocation.length, "this case must actually drop rows");

  const forVote = expectedUsdForWholePercentVote(allocation, budget);
  const keptRowsOnly = allocation
    .filter((a) => percents.some((p) => p.pool === a.pool))
    .reduce((sum, a) => sum + a.expectedUsd, 0);

  // Strictly more than the kept rows at their original sizes, because the
  // redistributed points buy real extra share in those same pools.
  assert.ok(forVote > keptRowsOnly, `${forVote} should exceed ${keptRowsOnly}`);

  // Recomputed independently from the percentages themselves.
  const expected = percents.reduce((sum, p) => {
    const row = allocation.find((a) => a.pool === p.pool)!;
    const votes = (p.percent / 100) * budget;
    return sum + (row.poolExpectedUsd * votes) / (row.existingVotes + votes);
  }, 0);
  assert.ok(Math.abs(forVote - expected) < 1e-9);
});

test("expectedUsdForWholePercentVote returns 0 for an empty allocation or a bad budget", () => {
  assert.equal(expectedUsdForWholePercentVote([], 1000), 0);
  const allocation = allocateAcrossCandidates(
    [{ address: "0xA", symbol: "A", existingVotes: 1000, expectedUsd: 200 }],
    1000,
  );
  for (const budget of [0, -1, NaN, Infinity]) {
    assert.equal(expectedUsdForWholePercentVote(allocation, budget), 0);
  }
});

test("the default allocation is castable: every row survives rounding to whole percent", () => {
  // The case that motivated the change: 1,000,000 veAERO across fifteen pools
  // on wildly different scales. At 400 steps the allocator handed nine of them
  // shares under 0.5%, which toWholePercentWeights then rounded to nothing, so
  // the printed table described a vote that could not be cast.
  const candidates = Array.from({ length: 15 }, (_, i) => ({
    address: `0x${i}`,
    symbol: `P${i}`,
    existingVotes: 10 ** (1 + (i % 5)),
    expectedUsd: 50 * (i + 1),
  }));
  const budget = 1_000_000;

  const allocation = allocateAcrossCandidates(candidates, budget);
  const percents = toWholePercentWeights(allocation);

  assert.equal(percents.length, allocation.length, "no row may be rounded away");
  assert.equal(
    percents.reduce((a, p) => a + p.percent, 0),
    100,
  );

  // And the finer granularity really did drop rows, so the guarantee above is
  // the change and not an accident of these particular numbers.
  const fine = allocateAcrossCandidates(candidates, budget, 400);
  assert.ok(toWholePercentWeights(fine).length < fine.length);
});

test("on the default lattice, the quoted total and the castable total are the same number", () => {
  // Two figures that used to disagree: what the table totals, and what the vote
  // you can actually type in is worth. On the 1% lattice there is nothing left
  // to round, so they must agree to the cent.
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    address: `0x${i}`,
    symbol: `P${i}`,
    existingVotes: 500 * (i + 1),
    expectedUsd: 40 * (i + 1),
  }));
  const budget = 250_000;

  const allocation = allocateAcrossCandidates(candidates, budget);
  const quoted = allocation.reduce((a, b) => a + b.expectedUsd, 0);
  const castable = expectedUsdForWholePercentVote(allocation, budget);

  assert.ok(Math.abs(quoted - castable) < 1e-6, `${quoted} vs ${castable}`);
});

test("every allocated amount is a whole percent of the budget", () => {
  // Checked across a spread of budgets and candidate counts rather than one
  // case, because the guarantee is arithmetic, not a property of these inputs.
  for (const budget of [1, 137, 25_000, 1_000_000, 8_432_119]) {
    for (const n of [1, 2, 7, 15]) {
      const candidates = Array.from({ length: n }, (_, i) => ({
        address: `0x${i}`,
        symbol: `P${i}`,
        existingVotes: 100 * (i + 1) ** 2,
        expectedUsd: 25 * (i + 1),
      }));

      const allocation = allocateAcrossCandidates(candidates, budget);
      const unit = budget / 100;

      for (const row of allocation) {
        const units = row.veAeroAllocated / unit;
        assert.ok(
          Math.abs(units - Math.round(units)) < 1e-6,
          `${row.symbol} got ${row.veAeroAllocated} of ${budget}, which is ${units} percentage points`,
        );
      }

      const spent = allocation.reduce((a, b) => a + b.veAeroAllocated, 0);
      assert.ok(Math.abs(spent - budget) < budget * 1e-9, `budget conservation: ${spent} vs ${budget}`);
    }
  }
});

test("maxWeight caps a pool that would otherwise take the whole vote", () => {
  // One pool is strictly better at every margin, so uncapped it takes 100%.
  const candidates = [
    { address: "0xA", symbol: "A", existingVotes: 1000, expectedUsd: 5000 },
    { address: "0xB", symbol: "B", existingVotes: 1000, expectedUsd: 50 },
    { address: "0xC", symbol: "C", existingVotes: 1000, expectedUsd: 40 },
  ];
  const budget = 10_000;

  const uncapped = allocateAcrossCandidates(candidates, budget);
  assert.equal(uncapped[0].symbol, "A");

  const capped = allocateAcrossCandidates(candidates, budget, undefined, 0.4);
  const aRow = capped.find((r) => r.symbol === "A")!;

  assert.ok(aRow.weight <= 0.4 + 1e-9, `A took ${aRow.weight}, cap was 0.4`);
  assert.ok(capped.length > 1, "the capped budget has to go somewhere");
  assert.ok(Math.abs(capped.reduce((a, b) => a + b.veAeroAllocated, 0) - budget) < 1e-6);
});

test("the cap is enforced on the lattice, so it is never exceeded by a rounding step", () => {
  const candidates = Array.from({ length: 6 }, (_, i) => ({
    address: `0x${i}`,
    symbol: `P${i}`,
    existingVotes: 100 * (i + 1),
    expectedUsd: 900 - i * 10,
  }));

  for (const cap of [0.2, 0.25, 0.33, 0.5, 0.75]) {
    const allocation = allocateAcrossCandidates(candidates, 50_000, undefined, cap);
    const percents = toWholePercentWeights(allocation);
    for (const p of percents) {
      assert.ok(p.percent <= Math.floor(cap * 100), `cap ${cap}: ${p.symbol} got ${p.percent}%`);
    }
  }
});

test("a cap too tight for the candidate set leaves veAERO unplaced rather than exceeding it", () => {
  // Three pools capped at 20% can hold 60% of the budget and no more. The
  // allocator must stop, not quietly overshoot — and the caller must be able to
  // see it, because toWholePercentWeights would scale the rows back to 100%.
  const candidates = Array.from({ length: 3 }, (_, i) => ({
    address: `0x${i}`,
    symbol: `P${i}`,
    existingVotes: 1000,
    expectedUsd: 500,
  }));
  const budget = 10_000;

  const allocation = allocateAcrossCandidates(candidates, budget, undefined, 0.2);
  const spent = allocation.reduce((a, b) => a + b.veAeroAllocated, 0);

  assert.ok(Math.abs(spent - budget * 0.6) < 1e-6, `expected 60% placed, got ${spent}`);
  assert.ok(Math.abs(unallocatedVeAero(allocation, budget) - budget * 0.4) < 1e-6);

  // The trap this guards: rounding renormalises and hands back 33/33/34.
  const percents = toWholePercentWeights(allocation);
  assert.equal(percents.reduce((a, p) => a + p.percent, 0), 100);
  assert.ok(percents.some((p) => p.percent > 20), "normalisation really does breach the cap");
});

test("unallocatedVeAero reports nothing for an ordinary uncapped allocation", () => {
  const candidates = [
    { address: "0xA", symbol: "A", existingVotes: 1000, expectedUsd: 500 },
    { address: "0xB", symbol: "B", existingVotes: 2000, expectedUsd: 400 },
  ];
  const allocation = allocateAcrossCandidates(candidates, 25_000);

  assert.equal(unallocatedVeAero(allocation, 25_000), 0);
  assert.equal(unallocatedVeAero([], 0), 0);
});

test("a cap of 1 or above changes nothing", () => {
  const candidates = [
    { address: "0xA", symbol: "A", existingVotes: 1000, expectedUsd: 5000 },
    { address: "0xB", symbol: "B", existingVotes: 1000, expectedUsd: 50 },
  ];
  const plain = allocateAcrossCandidates(candidates, 10_000);
  const capped = allocateAcrossCandidates(candidates, 10_000, undefined, 1);

  assert.deepEqual(capped, plain);
});
