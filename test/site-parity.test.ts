import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  allocateAcrossCandidates,
  toWholePercentWeights,
  expectedUsdForWholePercentVote,
  voteBasisCaveat,
  type AllocationCandidate,
  type VoteBasis,
} from "../src/allocator.js";
import { epochEndOf, formatDuration } from "../src/trend.js";
import { previousSettledVotes } from "../src/dilution.js";
import { VOTE_BASIS_CROSSOVER_VEAERO } from "../src/constants.js";

/**
 * The static site cannot import the TypeScript allocator: `docs/` is served by
 * GitHub Pages with no build step, and the whole point of the snapshot design is
 * that the page re-runs the allocation per keystroke in the browser. So
 * `docs/index.html` carries a hand-port of `src/allocator.ts`, labelled as one.
 *
 * A copy nothing checks is a copy that drifts, and the drift is silent: a fix
 * landed in the TypeScript (the V = 0 branch below is exactly such a fix) leaves
 * the page quietly recommending something else, with 100+ passing tests all
 * still green. This suite closes that gap by running the page's own source
 * against the real implementation on the same inputs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const siteSource = readFileSync(resolve(here, "../docs/index.html"), "utf8");

/**
 * Pulls one `function name(...) { ... }` declaration out of the page by matching
 * braces from its opening one. A regex can't do this safely — the bodies contain
 * braces in object literals and template strings — and depth-counting from a
 * known start is both simple and exact for source this shape.
 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `docs/index.html no longer defines ${name}() — did the page stop porting the allocator?`);

  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      seenBrace = true;
    } else if (source[i] === "}") {
      depth--;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}() from docs/index.html`);
}

type SiteAllocate = (input: unknown[], budget: number, steps?: number, maxWeight?: number) => { pool: string; symbol: string; weight: number; veAeroAllocated: number; expectedUsd: number }[];
type SitePercents = (allocation: unknown[]) => Map<string, number>;
type SiteExpected = (allocation: unknown[], budget: number) => number;

// `extractConst` is declared further down, next to the epoch-countdown port
// that first needed it; function declarations hoist, and keeping one copy is
// worth more than declaring it twice in reading order.
const siteModule = new Function(`
  ${extractFunction(siteSource, "marginalValuePerVeAero")}
  ${extractFunction(siteSource, "allocateAcrossCandidates")}
  ${extractFunction(siteSource, "toWholePercentWeights")}
  ${extractFunction(siteSource, "expectedUsdForWholePercentVote")}
  ${extractFunction(siteSource, "votesToExpect")}
  ${extractConst(siteSource, "VOTE_BASIS_CROSSOVER_VEAERO")}
  ${extractFunction(siteSource, "voteBasisCaveat")}
  return { allocateAcrossCandidates, toWholePercentWeights, expectedUsdForWholePercentVote, votesToExpect, voteBasisCaveat, VOTE_BASIS_CROSSOVER_VEAERO };
`)() as {
  allocateAcrossCandidates: SiteAllocate;
  toWholePercentWeights: SitePercents;
  expectedUsdForWholePercentVote: SiteExpected;
  votesToExpect: (pool: { votesVeAero: number; epochVotes?: number[]; currentEpochPartial?: boolean }) => number;
  voteBasisCaveat: (veAeroBudget: number, voteBasis: string) => string | null;
  VOTE_BASIS_CROSSOVER_VEAERO: number;
};

/** Candidate sets chosen to exercise the branches the two copies could disagree on. */
const cases: { name: string; candidates: AllocationCandidate[]; budget: number }[] = [
  {
    name: "two identical pools, budget large enough to force diversification",
    candidates: [
      { address: "0xA", symbol: "A", existingVotes: 1000, expectedUsd: 100 },
      { address: "0xB", symbol: "B", existingVotes: 1000, expectedUsd: 100 },
    ],
    budget: 10_000,
  },
  {
    name: "a pool nobody else has voted on, alongside a crowded one",
    candidates: [
      { address: "0xEMPTY", symbol: "EMPTY", existingVotes: 0, expectedUsd: 500 },
      { address: "0xCROWDED", symbol: "CROWDED", existingVotes: 1_000_000, expectedUsd: 100 },
    ],
    budget: 1000,
  },
  {
    name: "a worthless pool that must never be funded",
    candidates: [
      { address: "0xDEAD", symbol: "DEAD", existingVotes: 500, expectedUsd: 0 },
      { address: "0xLIVE", symbol: "LIVE", existingVotes: 500, expectedUsd: 250 },
    ],
    budget: 5000,
  },
  {
    name: "many pools on wildly different scales, so sub-1% rows appear",
    candidates: Array.from({ length: 15 }, (_, i) => ({
      address: `0x${i}`,
      symbol: `P${i}`,
      existingVotes: 10 ** (1 + (i % 5)),
      expectedUsd: 50 * (i + 1),
    })),
    budget: 1_000_000,
  },
];

for (const { name, candidates, budget } of cases) {
  test(`docs/index.html allocates identically to src/allocator.ts: ${name}`, () => {
    const ours = allocateAcrossCandidates(candidates, budget);
    const theirs = siteModule.allocateAcrossCandidates(candidates, budget);

    assert.equal(theirs.length, ours.length, "different number of funded pools");
    for (let i = 0; i < ours.length; i++) {
      assert.equal(theirs[i].pool, ours[i].pool, `row ${i}: different pool`);
      assert.ok(
        Math.abs(theirs[i].veAeroAllocated - ours[i].veAeroAllocated) < 1e-9,
        `row ${i} (${ours[i].symbol}): veAERO ${theirs[i].veAeroAllocated} vs ${ours[i].veAeroAllocated}`,
      );
      assert.ok(
        Math.abs(theirs[i].expectedUsd - ours[i].expectedUsd) < 1e-9,
        `row ${i} (${ours[i].symbol}): expected $ ${theirs[i].expectedUsd} vs ${ours[i].expectedUsd}`,
      );
    }
  });

  test(`docs/index.html rounds to the same whole percentages: ${name}`, () => {
    const ours = allocateAcrossCandidates(candidates, budget);
    const theirs = siteModule.allocateAcrossCandidates(candidates, budget);

    // The page returns a Map keyed by pool and leaves 0% rows in for its caller
    // to drop; the module returns an array with them already removed. Compare
    // the votable rows, which is what a user actually types into Aerodrome.
    const oursPercents = new Map(toWholePercentWeights(ours).map((p) => [p.pool, p.percent]));
    const theirsPercents = new Map(
      [...siteModule.toWholePercentWeights(theirs)].filter(([, percent]) => percent > 0),
    );

    assert.deepEqual(theirsPercents, oursPercents);
  });
}

for (const { name, candidates, budget } of cases) {
  test(`docs/index.html quotes the same expected $ for the cast vote: ${name}`, () => {
    const ours = expectedUsdForWholePercentVote(allocateAcrossCandidates(candidates, budget), budget);
    const theirs = siteModule.expectedUsdForWholePercentVote(
      siteModule.allocateAcrossCandidates(candidates, budget),
      budget,
    );
    assert.ok(Math.abs(theirs - ours) < 1e-9, `site says $${theirs}, module says $${ours}`);
  });
}

/**
 * The cap is the newest thing both copies have to agree on, and the one most
 * likely to drift: it is enforced inside the greedy loop, not applied to the
 * result afterwards, so a port that skips a single line reads as "cap ignored"
 * rather than as a crash.
 */
for (const cap of [0.5, 0.34, 0.25, 0.2]) {
  test(`docs/index.html honours a ${Math.round(cap * 100)}% cap the same way src/allocator.ts does`, () => {
    const candidates: AllocationCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      address: `0x${i}`,
      symbol: `P${i}`,
      existingVotes: 200 * (i + 1),
      expectedUsd: 800 - i * 40,
    }));
    const budget = 120_000;

    const ours = allocateAcrossCandidates(candidates, budget, undefined, cap);
    const theirs = siteModule.allocateAcrossCandidates(candidates, budget, undefined, cap);

    assert.equal(theirs.length, ours.length, "different number of funded pools under the cap");
    for (let i = 0; i < ours.length; i++) {
      assert.equal(theirs[i].pool, ours[i].pool, `row ${i}: different pool`);
      assert.ok(
        Math.abs(theirs[i].veAeroAllocated - ours[i].veAeroAllocated) < 1e-9,
        `row ${i} (${ours[i].symbol}): veAERO ${theirs[i].veAeroAllocated} vs ${ours[i].veAeroAllocated}`,
      );
      assert.ok(ours[i].weight <= cap + 1e-9, `${ours[i].symbol} breached the cap in src/`);
      assert.ok(theirs[i].weight <= cap + 1e-9, `${ours[i].symbol} breached the cap on the page`);
    }
  });
}

// The allocator isn't the only hand-port on the page: the vote-deadline
// countdown (`epochEndOf`/`formatDuration`, right by the code comment "matching
// epochEndOf/formatDuration in src/trend.ts") is copied the same way, for the
// same reason — `docs/` has no build step, so it cannot import `src/trend.ts`
// directly. Nothing checked that copy against the real one, which is exactly
// the silent-drift risk this file's docstring already describes for the
// allocator: a fix landed in `trend.ts` (say, a rounding correction to
// `formatDuration`) would leave the page quietly showing a different countdown
// to the one thing on this page that must never be stale, with every other
// test still green.

/**
 * `epochEndOf` on the page closes over the page's own `const EPOCH_SECONDS`
 * rather than taking it as a parameter, so extracting the function alone
 * leaves it referencing a name that doesn't exist in the sandboxed `Function`
 * scope. Pulled out the same brace/line-matching way as `extractFunction`,
 * rather than hardcoded here, so a changed value on the page is what this
 * test actually exercises.
 */
function extractConst(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name} = [^;]+;`));
  assert.notEqual(match, null, `docs/index.html no longer declares const ${name}`);
  return match![0];
}

const siteEpochModule = new Function(`
  ${extractConst(siteSource, "EPOCH_SECONDS")}
  ${extractFunction(siteSource, "epochEndOf")}
  ${extractFunction(siteSource, "formatDuration")}
  return { epochEndOf, formatDuration };
`)() as {
  epochEndOf: (unixSeconds: number) => number;
  formatDuration: (seconds: number) => string;
};

test("docs/index.html's epochEndOf matches src/trend.ts across a range of timestamps", () => {
  const samples = [
    0,
    1, // one second into the Unix epoch, itself a Thursday
    1_786_579_200, // a real Thursday 00:00 UTC boundary
    1_786_579_200 - 1, // the second before a boundary
    1_786_579_200 + 1, // the second after a boundary
    1_756_195_200, // an arbitrary "now" mid-epoch
  ];
  for (const s of samples) {
    assert.equal(siteEpochModule.epochEndOf(s), epochEndOf(s), `epochEndOf(${s})`);
  }
});

test("docs/index.html's formatDuration matches src/trend.ts across a range of durations", () => {
  const samples = [-100, 0, 1, 59, 60, 61, 3599, 3600, 3660, 86_399, 86_400, 86_400 * 2 + 3661, NaN, Infinity];
  for (const s of samples) {
    assert.equal(siteEpochModule.formatDuration(s), formatDuration(s), `formatDuration(${s})`);
  }
});

/**
 * The page picks the allocator's denominator itself, so `votesToExpect` is a
 * second hand-port sitting on the same drift risk as the allocator. It decides
 * which pools the suggestion funds, so a copy that quietly disagreed with
 * `previousSettledVotes` would change real vote weights.
 */
test("docs/index.html's votesToExpect matches src/dilution.ts", () => {
  const cases: { votesVeAero: number; epochVotes?: number[]; currentEpochPartial?: boolean }[] = [
    // Mid-week: entry 0 is the running tally, so last epoch's weight is entry 1.
    { votesVeAero: 452_000, epochVotes: [452_000, 11_600_000, 9_000_000], currentEpochPartial: true },
    { votesVeAero: 9_000, epochVotes: [9_000, 3_000, 3_000], currentEpochPartial: true },
    // A settled series: entry 0 already is the previous epoch.
    { votesVeAero: 5_000, epochVotes: [7_000, 6_000], currentEpochPartial: false },
    // Nothing to read: fall back to what the pool actually carries.
    { votesVeAero: 1_234, epochVotes: [1_234], currentEpochPartial: true },
    { votesVeAero: 1_234, epochVotes: [1_234, 0], currentEpochPartial: true },
    { votesVeAero: 1_234 },
    { votesVeAero: 0, epochVotes: [0, 4_000], currentEpochPartial: true },
  ];

  for (const c of cases) {
    assert.equal(
      siteModule.votesToExpect(c),
      previousSettledVotes(c.epochVotes ?? [], c.currentEpochPartial ?? true, c.votesVeAero),
      `votesToExpect disagreed for ${JSON.stringify(c)}`,
    );
  }
});

/**
 * The caveat is the one place where the page tells a visitor that the number
 * above it rests on a basis the evidence does not support at their size. If the
 * two copies drifted, the page could go on reassuring a voter the CLI would
 * warn — the worst direction for a disagreement to run.
 */
test("docs/index.html's vote-basis crossover is the same number as src/constants.ts", () => {
  assert.equal(siteModule.VOTE_BASIS_CROSSOVER_VEAERO, VOTE_BASIS_CROSSOVER_VEAERO);
});

test("docs/index.html's voteBasisCaveat matches src/allocator.ts word for word", () => {
  const budgets = [
    1,
    25_000,
    VOTE_BASIS_CROSSOVER_VEAERO - 1,
    VOTE_BASIS_CROSSOVER_VEAERO,
    VOTE_BASIS_CROSSOVER_VEAERO + 1,
    5_000_000,
    0,
    -1,
    Number.NaN,
  ];
  const bases: VoteBasis[] = ["previous", "current", "typical"];

  for (const budget of budgets) {
    for (const basis of bases) {
      assert.equal(
        siteModule.voteBasisCaveat(budget, basis),
        voteBasisCaveat(budget, basis),
        `voteBasisCaveat disagreed at ${budget} veAERO on "${basis}"`,
      );
    }
  }
});
