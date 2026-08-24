import { fetchActivePools, fetchPoolEpochs, type PoolInfo, type EpochData } from "./pools.js";
import { getTokenPrices, toUsd, countUnpricedTokens } from "./prices.js";
import { TREND_EPOCHS, MIN_TRAILING_USD } from "./constants.js";
import { mapWithConcurrency } from "./util.js";

const VE_DECIMALS = 18;

export interface PoolEfficiency {
  pool: PoolInfo;
  latestEpochTs: number;
  currentVotesVeAero: number;
  latestEpochUsd: number;
  /** Simple trailing average of the last few epochs' USD value — a naive forecast, not an ML prediction. */
  trailingAvgUsd: number;
  epochsObserved: number;
  currentValuePerVote: number;
  predictedValuePerVote: number;
  /** predictedValuePerVote / currentValuePerVote - 1. Positive = incentives trending above what current votes are capturing. */
  predictiveEdge: number;
  /**
   * Each observed epoch's USD value, most recent first — the raw series the
   * trailing average, volatility and consistency are all derived from.
   *
   * Kept rather than discarded because averaging is lossy in a way that hides
   * direction: a pool ramping from $50 to $500 and one decaying from $500 to
   * $50 produce the same `trailingAvgUsd` and the same `consistency`. Holding
   * the series makes trend (and a chart of it) possible without a second
   * on-chain fetch, since these values are computed here anyway.
   */
  epochUsdSeries: number[];
  /** Coefficient of variation of the observed epochs' USD values. 0 = identical every epoch; 1 = std dev as large as the mean. */
  volatility: number;
  /** 1 / (1 + volatility), so 1 = perfectly steady and lower = spikier. See `computeConsistency`. */
  consistency: number;
}

/**
 * Scores how *steady* a pool's incentives have been, not just how large they
 * average out to. The trailing average alone can't tell these apart:
 *
 *   pool A: $100 $100 $100 $100 $100 $100  → avg $100, dependable
 *   pool B: $600   $0   $0   $0   $0   $0  → avg $100, a single one-off bribe
 *
 * Both rank identically on `predictedValuePerVote`, but voting into B is a bet
 * that a one-week event repeats, which is a materially different proposition.
 * We report the coefficient of variation (population std dev ÷ mean, so it's
 * scale-free and comparable across a $50/epoch pool and a $50,000/epoch one)
 * and map it to a friendlier 0..1 `consistency` via 1/(1+cv).
 *
 * A single observed epoch returns consistency 0 rather than 1: one data point
 * cannot demonstrate steadiness, and claiming perfect consistency from it would
 * flatter brand-new pools exactly where the tool should be most cautious.
 * `epochsObserved` is what distinguishes "unproven" from "genuinely erratic",
 * and a non-zero `--min-consistency` filter therefore excludes both.
 */
export function computeConsistency(values: number[]): { volatility: number; consistency: number } {
  if (values.length < 2) return { volatility: 0, consistency: 0 };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return { volatility: 0, consistency: 0 };

  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  const volatility = Math.sqrt(variance) / mean;
  return { volatility, consistency: 1 / (1 + volatility) };
}

export function epochUsd(
  epoch: { bribes: { token: string; amount: bigint }[]; fees: { token: string; amount: bigint }[] },
  prices: Map<string, { price: number; decimals: number }>,
): number {
  let total = 0;
  for (const b of epoch.bribes) total += toUsd(b.amount, b.token, prices);
  for (const f of epoch.fees) total += toUsd(f.amount, f.token, prices);
  return total;
}

/**
 * Turns one pool's already-fetched epoch history into its efficiency metrics, or
 * null if the pool should be excluded (no epoch data, zero recorded votes, or a
 * trailing average too thin to be a meaningful signal). Pure and chain-free, so
 * it's unit-testable without mocking RPC calls — unlike `rankPoolsByEfficiency`,
 * which fetches live.
 */
export function computePoolEfficiency(
  pool: PoolInfo,
  epochs: EpochData[],
  prices: Map<string, { price: number; decimals: number }>,
): PoolEfficiency | null {
  if (!epochs || epochs.length === 0) return null;

  const latest = epochs[0];
  const currentVotesVeAero = Number(latest.votes) / 10 ** VE_DECIMALS;
  if (currentVotesVeAero <= 0) return null;

  const latestEpochUsd = epochUsd(latest, prices);
  const usdValues = epochs.map((e) => epochUsd(e, prices));
  const trailingAvgUsd = usdValues.reduce((a, b) => a + b, 0) / usdValues.length;
  if (trailingAvgUsd < MIN_TRAILING_USD) return null; // too thin to be a meaningful signal

  const currentValuePerVote = latestEpochUsd / currentVotesVeAero;
  const predictedValuePerVote = trailingAvgUsd / currentVotesVeAero;
  const predictiveEdge =
    currentValuePerVote > 0 ? predictedValuePerVote / currentValuePerVote - 1 : 0;
  const { volatility, consistency } = computeConsistency(usdValues);

  return {
    pool,
    latestEpochTs: latest.ts,
    currentVotesVeAero,
    latestEpochUsd,
    trailingAvgUsd,
    epochsObserved: epochs.length,
    epochUsdSeries: usdValues,
    currentValuePerVote,
    predictedValuePerVote,
    predictiveEdge,
    volatility,
    consistency,
  };
}

/**
 * Ranks all gauge-live Aerodrome pools by current and trend-predicted $-value
 * per veAERO vote. Pools with zero recorded votes are excluded — $-per-vote is
 * undefined for them, not infinite opportunity.
 */
export async function rankPoolsByEfficiency(): Promise<PoolEfficiency[]> {
  const pools = await fetchActivePools();

  // Bound concurrency: firing one RPC call per pool at once (there can be hundreds
  // of live-gauge pools) reliably trips the public RPC's rate limit.
  //
  // A single pool's epoch call can fail on its own (e.g. a transient RPC error
  // or a non-standard pool the rewards contract can't resolve) without the rest
  // of the pools being at fault, so we catch per-pool rather than letting one
  // failure reject the whole batch and take down `pools`/`recommend` entirely.
  let epochFetchFailures = 0;
  const epochsByPool = await mapWithConcurrency(pools, 8, (p) =>
    fetchPoolEpochs(p.address, TREND_EPOCHS).catch(() => {
      epochFetchFailures++;
      return [];
    }),
  );
  if (epochFetchFailures > 0) {
    console.error(`(skipped ${epochFetchFailures} pool(s) whose epoch history failed to load)`);
  }

  const allTokens = epochsByPool.flat().flatMap((e) => [
    ...e.bribes.map((b) => b.token),
    ...e.fees.map((f) => f.token),
  ]);
  const prices = await getTokenPrices(allTokens);
  const unpriced = countUnpricedTokens(prices);
  if (unpriced > 0) {
    console.error(
      `(${unpriced} of ${prices.size} reward token(s) have no USD price and count as $0 — pools paid only in those will look empty)`,
    );
  }

  const results: PoolEfficiency[] = [];

  pools.forEach((pool, i) => {
    const result = computePoolEfficiency(pool, epochsByPool[i], prices);
    if (result) results.push(result);
  });

  return results.sort((a, b) => b.predictedValuePerVote - a.predictedValuePerVote);
}
