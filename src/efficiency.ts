import { fetchActivePools, fetchPoolEpochs, type PoolInfo, type EpochData } from "./pools.js";
import { getTokenPrices, toUsd } from "./prices.js";
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

  return {
    pool,
    latestEpochTs: latest.ts,
    currentVotesVeAero,
    latestEpochUsd,
    trailingAvgUsd,
    epochsObserved: epochs.length,
    currentValuePerVote,
    predictedValuePerVote,
    predictiveEdge,
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

  const results: PoolEfficiency[] = [];

  pools.forEach((pool, i) => {
    const result = computePoolEfficiency(pool, epochsByPool[i], prices);
    if (result) results.push(result);
  });

  return results.sort((a, b) => b.predictedValuePerVote - a.predictedValuePerVote);
}
