import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rankPoolsByEfficiency } from "./efficiency.js";
import type { PoolEfficiency } from "./efficiency.js";

/**
 * The published shape of one pool in the snapshot. This is deliberately a
 * superset of the CLI's `poolEfficiencyToJson`: the static site re-runs the
 * *real* allocator in the browser, and `allocateAcrossCandidates` needs each
 * pool's existing vote weight and its expected epoch value in dollars. The CLI
 * shape carries neither (it publishes the derived per-vote figures instead), so
 * a site built on that shape alone could only re-rank, never allocate.
 */
export interface SnapshotPool {
  symbol: string;
  pool: string;
  votesVeAero: number;
  /** Trailing-average USD per epoch — the allocator's `expectedUsd` input. */
  trailingAvgUsd: number;
  latestEpochUsd: number;
  currentValuePerVote: number;
  predictedValuePerVote: number;
  predictiveEdge: number;
  epochsObserved: number;
  volatility: number;
  consistency: number;
}

export interface Snapshot {
  /** ISO timestamp of when the scan ran, so the page can show its own staleness. */
  generatedAt: string;
  /** Unix seconds of the most recent epoch seen across all pools. */
  latestEpochTs: number;
  poolCount: number;
  pools: SnapshotPool[];
}

export function toSnapshotPool(p: PoolEfficiency): SnapshotPool {
  return {
    symbol: p.pool.symbol,
    pool: p.pool.address,
    votesVeAero: p.currentVotesVeAero,
    trailingAvgUsd: p.trailingAvgUsd,
    latestEpochUsd: p.latestEpochUsd,
    currentValuePerVote: p.currentValuePerVote,
    predictedValuePerVote: p.predictedValuePerVote,
    predictiveEdge: p.predictiveEdge,
    epochsObserved: p.epochsObserved,
    volatility: p.volatility,
    consistency: p.consistency,
  };
}

/**
 * Assembles the snapshot from an already-ranked pool list. Pure, so it's
 * unit-testable without hitting the chain — unlike `main`, which fetches live.
 *
 * `latestEpochTs` is the maximum rather than the first pool's: pools are sorted
 * by predicted value, not by recency, and a pool whose rewards contract has not
 * been touched this week reports an older epoch. Taking the max answers the
 * question the page actually asks ("which epoch is this data about?") instead of
 * whichever epoch the top-ranked pool happened to be sitting on.
 */
export function buildSnapshot(ranked: PoolEfficiency[], generatedAt: Date): Snapshot {
  const pools = ranked.map(toSnapshotPool);
  return {
    generatedAt: generatedAt.toISOString(),
    latestEpochTs: ranked.reduce((max, p) => Math.max(max, p.latestEpochTs), 0),
    poolCount: pools.length,
    pools,
  };
}

/**
 * Runs the live scan and writes the snapshot the static site reads. The heavy
 * part (one epoch-history call per live-gauge pool, hundreds of them) is far too
 * slow and rate-limited to run from a visitor's browser on a public RPC, so it
 * runs on a schedule in CI and the result is committed as a plain JSON file. The
 * page then does only the cheap part — the personalised allocation — client-side.
 */
export async function writeSnapshot(outPath: string): Promise<Snapshot> {
  const ranked = await rankPoolsByEfficiency();
  if (ranked.length === 0) {
    // Refuse to publish an empty snapshot. A failed or rate-limited scan would
    // otherwise overwrite a perfectly good file with zero pools, and the site
    // would show "no pools" rather than yesterday's still-useful data.
    throw new Error("scan produced no pools — refusing to overwrite the existing snapshot");
  }

  const snapshot = buildSnapshot(ranked, new Date());

  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  return snapshot;
}
