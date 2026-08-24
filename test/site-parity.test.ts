import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { allocateAcrossCandidates, toWholePercentWeights, type AllocationCandidate } from "../src/allocator.js";

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

type SiteAllocate = (input: unknown[], budget: number, steps?: number) => { pool: string; symbol: string; weight: number; veAeroAllocated: number; expectedUsd: number }[];
type SitePercents = (allocation: unknown[]) => Map<string, number>;

const siteModule = new Function(`
  ${extractFunction(siteSource, "marginalValuePerVeAero")}
  ${extractFunction(siteSource, "allocateAcrossCandidates")}
  ${extractFunction(siteSource, "toWholePercentWeights")}
  return { allocateAcrossCandidates, toWholePercentWeights };
`)() as { allocateAcrossCandidates: SiteAllocate; toWholePercentWeights: SitePercents };

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
