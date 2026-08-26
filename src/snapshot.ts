import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { rankPoolsByEfficiency } from "./efficiency.js";
import { computeTrend, epochEndOf, isEpochInProgress, EPOCH_SECONDS } from "./trend.js";
import { computeVoteStability, previousSettledVotes } from "./dilution.js";
import type { PoolEfficiency } from "./efficiency.js";

/**
 * The published shape of one pool in the snapshot. This is deliberately a
 * superset of the CLI's `poolEfficiencyToJson`: the static site re-runs the
 * allocator in the browser — a hand-port of `src/allocator.ts`, since `docs/`
 * is served with no build step, held to the real one by `test/site-parity.test.ts`
 * — and `allocateAcrossCandidates` needs each
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
  /** Unix seconds of this pool's most recent epoch. Older epochs are one week apart, so the whole series' dates follow from it. */
  latestEpochTs: number;
  /**
   * Per-epoch USD value, most recent first — what the page charts. Published as
   * the raw series rather than a pre-rendered shape so the page can draw it, and
   * a reader can check it, without a second source of truth.
   */
  epochUsd: number[];
  /**
   * True when `epochUsd[0]` is the epoch still running, and therefore a partial
   * week that is not comparable to the finished ones next to it. The page draws
   * that bar differently and the trend ignores it.
   */
  currentEpochPartial: boolean;
  /** Recent completed epochs' average over the older ones', minus 1. Null when there is no honest basis for it — see `computeTrend`. */
  momentum: number | null;
  /** Per-epoch settled vote weight, most recent first — the denominator's history, matching `epochUsd` for the numerator. */
  epochVotes: number[];
  /** The weight this pool typically settles at (median of completed epochs), or null with too little history. See `computeVoteStability`. */
  expectedVotes: number | null;
  /** `expectedVotes / votesVeAero`. Above 1 means the per-vote figures here are optimistic by roughly this factor. Null when not comparable. */
  refillRatio: number | null;
  /** 1 / (1 + coefficient of variation) of the completed epochs' vote weights. Low = a denominator that jumps around. */
  voteStability: number;
  /**
   * `trailingAvgUsd` divided by the weight the pool settled at last epoch — the
   * most accurate available prediction of the weight this epoch will settle at,
   * and what the allocator divides by. Published alongside
   * `predictedValuePerVote` (which divides by the live mid-week tally) rather
   * than replacing it, so the gap between the two is visible rather than
   * quietly applied.
   */
  dilutionAdjustedValuePerVote: number;
}

/**
 * Protocol-wide voter yield for one epoch: every pool's incentives added up over
 * every pool's votes added up.
 *
 * This answers a question the per-pool ranking structurally cannot. The rest of
 * the snapshot is about choosing *between* pools, and a ranking looks exactly
 * the same whether the pot it is dividing is growing or collapsing. Measured
 * across this scan's own history the pot fell far faster than the vote weight
 * did, which is a different problem from dilution and one that picking a better
 * pool cannot fix — so it is published rather than left for the reader to
 * reconstruct from 300 pools' worth of series.
 */
export interface EpochYield {
  /** Unix seconds of the epoch's start (Thursday 00:00 UTC). */
  ts: number;
  /** Every pool's bribes + fees for that epoch, in USD. */
  totalUsd: number;
  /** Every pool's settled vote weight for that epoch, in veAERO. */
  totalVotes: number;
  /** `totalUsd / totalVotes` — what one veAERO earned that epoch, across the whole protocol. */
  usdPerVote: number;
  /** How many pools contributed an entry for this epoch. */
  pools: number;
  /** True for the epoch still running, whose totals are a part-week and not comparable to the finished ones. */
  partial: boolean;
}

export interface Snapshot {
  /** ISO timestamp of when the scan ran, so the page can show its own staleness. */
  generatedAt: string;
  /** Unix seconds of the most recent epoch seen across all pools. */
  latestEpochTs: number;
  /**
   * Unix seconds at which the epoch running when this scan happened flips — the
   * deadline for a vote to count toward it. Published because a snapshot is a
   * recommendation with an expiry, and anything reading the JSON on its own had
   * no way to tell whether it was still actionable. Derived from `generatedAt`
   * rather than from `latestEpochTs`, which can lag on pools whose rewards
   * contract has not been touched this week.
   */
  epochEndsAt: number;
  poolCount: number;
  pools: SnapshotPool[];
  /** Protocol-wide voter yield per epoch, newest first — see `buildEpochYields`. */
  epochYields: EpochYield[];
}

/**
 * `generatedAt` is a parameter rather than read from the clock inside: whether a
 * pool's newest epoch was still running is a fact about when the scan ran, and
 * taking it from the same timestamp the snapshot publishes keeps the flag and
 * the `generatedAt` field from ever disagreeing (and keeps this pure/testable).
 */
export function toSnapshotPool(p: PoolEfficiency, generatedAt: Date): SnapshotPool {
  const currentEpochPartial = isEpochInProgress(p.latestEpochTs, Math.floor(generatedAt.getTime() / 1000));
  const { momentum } = computeTrend(p.epochUsdSeries, currentEpochPartial);
  const { expectedVotes, refillRatio, voteStability } = computeVoteStability(
    p.epochVotesSeries,
    currentEpochPartial,
    p.currentVotesVeAero,
  );
  const dilutedVotes = previousSettledVotes(p.epochVotesSeries, currentEpochPartial, p.currentVotesVeAero);

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
    latestEpochTs: p.latestEpochTs,
    epochUsd: p.epochUsdSeries,
    currentEpochPartial,
    momentum,
    epochVotes: p.epochVotesSeries,
    expectedVotes,
    refillRatio,
    voteStability,
    dilutionAdjustedValuePerVote: dilutedVotes > 0 ? p.trailingAvgUsd / dilutedVotes : 0,
  };
}

/**
 * Aggregates every pool's per-epoch series into one protocol-wide yield figure
 * per epoch, newest first.
 *
 * Pools are summed rather than averaged: the question is what the whole pot paid
 * per unit of whole vote weight, and averaging per-pool rates would weight a
 * 2,000-vote pool the same as a 60,000,000-vote one. Epochs are keyed by
 * timestamp rather than by position in each pool's array, because pools do not
 * all carry the same history depth and index 3 is a different week for different
 * pools.
 *
 * Two limits are worth stating rather than hiding: reward tokens are valued at
 * today's prices even for old epochs (that is what the price source returns),
 * and only pools with a live gauge today are in the scan at all. Both push the
 * older figures *down*, so a decline measured this way is a floor on the real
 * one, not an exaggeration of it.
 */
export function buildEpochYields(ranked: PoolEfficiency[], generatedAt: Date): EpochYield[] {
  const asOf = Math.floor(generatedAt.getTime() / 1000);
  const byTs = new Map<number, { totalUsd: number; totalVotes: number; pools: number }>();

  for (const p of ranked) {
    const depth = Math.min(p.epochUsdSeries.length, p.epochVotesSeries.length);
    for (let i = 0; i < depth; i++) {
      // The series are most-recent-first and one week apart, so each entry's
      // epoch follows from the pool's own latest epoch rather than from a clock.
      const ts = p.latestEpochTs - i * EPOCH_SECONDS;
      const acc = byTs.get(ts) ?? { totalUsd: 0, totalVotes: 0, pools: 0 };
      acc.totalUsd += p.epochUsdSeries[i];
      acc.totalVotes += p.epochVotesSeries[i];
      acc.pools += 1;
      byTs.set(ts, acc);
    }
  }

  return [...byTs.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([ts, a]) => ({
      ts,
      totalUsd: a.totalUsd,
      totalVotes: a.totalVotes,
      usdPerVote: a.totalVotes > 0 ? a.totalUsd / a.totalVotes : 0,
      pools: a.pools,
      partial: isEpochInProgress(ts, asOf),
    }));
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
  const pools = ranked.map((p) => toSnapshotPool(p, generatedAt));
  return {
    generatedAt: generatedAt.toISOString(),
    latestEpochTs: ranked.reduce((max, p) => Math.max(max, p.latestEpochTs), 0),
    epochEndsAt: epochEndOf(Math.floor(generatedAt.getTime() / 1000)),
    poolCount: pools.length,
    pools,
    epochYields: buildEpochYields(ranked, generatedAt),
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
