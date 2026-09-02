#!/usr/bin/env node
/**
 * `npm run predict-check` — measures which vote basis actually predicts the
 * weight an epoch settles at.
 *
 * The vantage point is the whole trick. A backtest replaying a closed epoch has
 * no mid-week vote tally to work from, so `previous` and `current` collapse to
 * the same number there and it cannot separate them. But every scan this repo
 * has ever committed to `docs/data/snapshot.json` recorded the live tally at
 * that moment, six-hourly — so each scan taken inside an epoch that has since
 * settled *is* a real mid-week vantage point, with the answer now known.
 *
 * So: walk the git history of the snapshot, keep the scans from settled epochs,
 * and score each basis against what those epochs settled at.
 *
 * Limits, which the report restates rather than leaving to be discovered:
 * observations within one pool are not independent (the same pool appears at
 * every scan time), and only epochs with snapshot coverage can be scored.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchActivePools, fetchPoolEpochs } from "./pools.js";
import { getTokenPrices } from "./prices.js";
import { epochUsd } from "./efficiency.js";
import { periodStartOf } from "./trend.js";
import { formatError, mapWithConcurrency } from "./util.js";
import { TREND_EPOCHS } from "./constants.js";
import {
  asRatio,
  inBucket,
  observationsFromSnapshot,
  scorePredictors,
  SIZE_BUCKETS,
  type PredictionObservation,
} from "./predict.js";

const VE_DECIMALS = 18;
const SNAPSHOT_PATH = "docs/data/snapshot.json";
const BASES = ["previous", "current", "typical"];

/** Every committed version of the snapshot, newest first. Empty if git is unavailable. */
function snapshotsFromGit(): unknown[] {
  let shas: string[];
  try {
    shas = execFileSync("git", ["log", "--format=%H", "--", SNAPSHOT_PATH], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    console.error("Could not read the snapshot history from git. Pass a directory of snapshot JSON files instead.");
    return [];
  }

  const out: unknown[] = [];
  for (const sha of shas) {
    try {
      out.push(JSON.parse(execFileSync("git", ["show", `${sha}:${SNAPSHOT_PATH}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })));
    } catch {
      // A commit from before the file existed, or one whose JSON never parsed.
      // Skipping it is right: one unreadable revision is not a reason to refuse
      // to measure anything.
    }
  }
  return out;
}

/**
 * Every `.json` file in `dir`, parsed. Skips a file that can't be read or
 * doesn't parse rather than letting it crash the whole measurement — the same
 * tolerance `snapshotsFromGit` already has for a commit whose JSON never
 * parsed, and for the same reason: one bad file (partial write, an unrelated
 * JSON file that happens to sit in the directory) is not a reason to refuse to
 * measure the rest of it.
 */
export function snapshotsFromDir(dir: string): unknown[] {
  const out: unknown[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch (err) {
      console.error(`(skipping ${f}: ${formatError(err)})`);
    }
  }
  return out;
}

async function main() {
  const dir = process.argv[2];
  const snapshots = dir ? snapshotsFromDir(dir) : snapshotsFromGit();
  if (snapshots.length === 0) {
    console.error("No snapshots to measure.");
    process.exitCode = 1;
    return;
  }

  const pools = await fetchActivePools();
  // Deep enough that a scan from the oldest covered epoch still has a full
  // trailing window strictly older than the epoch it is predicting.
  const depth = TREND_EPOCHS + 10;
  const epochsByPool = await mapWithConcurrency(pools, 8, (p) =>
    fetchPoolEpochs(p.address, depth).catch(() => []),
  );
  const allTokens = epochsByPool.flat().flatMap((e) => [
    ...e.bribes.map((b) => b.token),
    ...e.fees.map((f) => f.token),
  ]);
  const prices = await getTokenPrices(allTokens);

  // address -> epoch start -> settled weight / USD, so a scan can be paired with
  // the epoch it was taken inside regardless of how deep each pool's history is.
  const settledVotes = new Map<string, Map<number, number>>();
  const settledUsd = new Map<string, Map<number, number>>();
  pools.forEach((pool, i) => {
    const votes = new Map<number, number>();
    const usd = new Map<number, number>();
    for (const e of epochsByPool[i]) {
      votes.set(e.ts, Number(e.votes) / 10 ** VE_DECIMALS);
      usd.set(e.ts, epochUsd(e, prices));
    }
    settledVotes.set(pool.address.toLowerCase(), votes);
    settledUsd.set(pool.address.toLowerCase(), usd);
  });

  const currentEpochStart = periodStartOf(Math.floor(Date.now() / 1000));
  const observations: PredictionObservation[] = [];
  const epochsCovered = new Set<number>();
  const poolsSeen = new Set<string>();

  for (const raw of snapshots) {
    const result = observationsFromSnapshot(raw, settledVotes, settledUsd, currentEpochStart);
    if (!result) continue;
    for (const { address, observation } of result.entries) {
      observations.push(observation);
      epochsCovered.add(result.epochStart);
      poolsSeen.add(address);
    }
  }

  if (observations.length === 0) {
    console.error(
      "No scorable observations. This needs snapshots taken inside an epoch that has since settled — the history may not reach back that far yet.",
    );
    process.exitCode = 1;
    return;
  }

  const pct = (n: number) => `${(asRatio(n) * 100).toFixed(0)}%`;
  const signed = (n: number) => `${asRatio(n) >= 0 ? "+" : ""}${(asRatio(n) * 100).toFixed(0)}%`;

  const dates = [...epochsCovered]
    .sort((a, b) => a - b)
    .map((t) => new Date(t * 1000).toISOString().slice(0, 10));

  console.log(
    `\nPredicting the vote weight each epoch settled at, from real mid-week vantage points.`,
  );
  console.log(
    `${observations.length.toLocaleString("en-US")} observations · ${poolsSeen.size} pools · ${epochsCovered.size} settled epoch(s): ${dates.join(", ")}\n`,
  );

  const row = (label: string, obs: PredictionObservation[]) => {
    const scores = scorePredictors(obs, BASES);
    console.log(label);
    for (const s of scores) {
      console.log(
        "  " +
          s.name.padEnd(10) +
          String(s.observations).padStart(8) +
          pct(s.medianAbsError).padStart(10) +
          signed(s.medianBias).padStart(10) +
          String(s.closestOn).padStart(12),
      );
    }
  };

  console.log("  basis".padEnd(12) + "n".padStart(8) + "error".padStart(10) + "bias".padStart(10) + "closest on".padStart(12));
  console.log("  " + "-".repeat(48));
  row("  all observations:", observations);

  for (const bucket of SIZE_BUCKETS) {
    const subset = observations.filter((o) => inBucket(o, bucket));
    if (subset.length === 0) continue;
    console.log("");
    row(`  ${bucket.label}:`, subset);
  }

  console.log(
    "\nError is the median absolute miss on a log scale, so 17% means the typical guess is 17% out;" +
      "\npayout depends on weight multiplicatively, which is why it is not measured in votes. Bias is" +
      "\nthe median signed miss: a predictor can be no noisier than another and still be systematically" +
      "\nhigh, and the allocator divides by this figure, so that bias reaches every pool it prices.",
  );
  console.log(
    "\nTreat the count as fewer independent points than it looks: the same pool appears at every scan" +
      "\ntime, so observations within a pool are correlated. Only epochs with snapshot coverage can be" +
      "\nscored at all.",
  );
}

// Only run when this file is executed directly (as `npm run predict-check`),
// not when it's imported — e.g. by tests importing `snapshotsFromDir`. Without
// this, importing the module for its pure helpers would also kick off `main`'s
// live chain scan, the same hazard `mcp-server.ts` guards against for the same
// reason.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(`Error: ${formatError(err)}`);
    process.exitCode = 1;
  });
}
