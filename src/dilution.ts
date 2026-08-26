import { MIN_VOTE_BASELINE } from "./constants.js";

/**
 * Fewest completed epochs of vote history needed before a typical-weight figure
 * is reported. Two is genuinely the minimum that means anything: one completed
 * epoch cannot distinguish "this is what the pool normally carries" from "this
 * is what happened once", which is the whole distinction this module exists to
 * draw. Same reasoning as `computeConsistency` refusing to score a single epoch.
 */
export const MIN_VOTE_EPOCHS = 2;

export interface VoteStability {
  /**
   * The vote weight this pool *typically* settles at — the median of its
   * completed epochs, or null when there is too little completed history.
   *
   * Median rather than mean on purpose. The distortion being measured here is
   * a single epoch's parked block of veAERO, and a mean is exactly the statistic
   * that one outlier drags around: on live data a pool whose weight ran
   * 3.9M/3.5M/4.6M/2.2M/774k/18.1M/280k has a mean of 4.8M and a median of 3.5M,
   * and 3.5M is the honest answer to "what does this pool normally carry".
   */
  expectedVotes: number | null;
  /**
   * `expectedVotes / currentVotes`. Above 1 means the pool normally settles with
   * more weight than it is showing right now, so the per-vote figure computed
   * against the current weight is optimistic by roughly this factor.
   *
   * Null when there is no completed history to compare against, or when the
   * current weight is too small to divide by — see `computeVoteStability`.
   */
  refillRatio: number | null;
  /** Coefficient of variation of the completed epochs' vote weights. 0 = identical every epoch. */
  voteVolatility: number;
  /** 1 / (1 + voteVolatility), so 1 = a rock-steady denominator and lower = one that jumps around. */
  voteStability: number;
  /** How many completed epochs the figures were drawn from (the in-progress one excluded). */
  completedEpochs: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Describes how trustworthy a pool's *current* vote weight is as a predictor of
 * the weight it will actually settle at.
 *
 * Why this exists, and why it is a correctness fix rather than a nicety:
 * `predictedValuePerVote` divides a six-epoch average numerator by a single
 * instantaneous denominator. That is only honest if the denominator is stable.
 * On Aerodrome it frequently is not, for a structural reason — votes carry over
 * between epochs, so a pool's mid-week weight is largely inherited from last
 * week, and holders rewrite it when they re-vote. Measured against this repo's
 * own six-hourly snapshot history, roughly 29-30% of all vote weight across the
 * protocol is added or removed in the final five hours before an epoch closes.
 *
 * The consequence is not subtle. On live data at the time this was written, the
 * top-ranked pool showed 452k votes against a typical settled weight of 11.6M —
 * so its advertised $0.01543 per vote was really about $0.00065 once the weight
 * came back, a 24x overstatement, and twelve of the top twenty pools carried a
 * typical weight at least twice their current one.
 *
 * `epochVotes` is most-recent-first, matching the contract's own ordering, and
 * `currentEpochPartial` says whether entry 0 is the epoch still running. The
 * running epoch is excluded from the typical-weight statistics for the same
 * reason `computeTrend` excludes it: its weight is still being written, so
 * folding it in would drag the "typical" figure toward whatever this week
 * happens to look like right now.
 *
 * `currentVotes` is floored before dividing. An unguarded ratio against a
 * near-empty pool produces a spectacular number that means nothing — the same
 * failure `computeTrend` hit with a $0.02 baseline reading as +29,286% — so a
 * pool sitting below the floor reports a null `refillRatio` rather than a
 * headline one. `expectedVotes` is still reported, because a caller comparing
 * it against the current weight themselves is not misled by it.
 */
export function computeVoteStability(
  epochVotes: number[],
  currentEpochPartial: boolean,
  currentVotes: number,
  minVoteBaseline: number = MIN_VOTE_BASELINE,
): VoteStability {
  const completed = currentEpochPartial ? epochVotes.slice(1) : epochVotes.slice();
  const none: VoteStability = {
    expectedVotes: null,
    refillRatio: null,
    voteVolatility: 0,
    voteStability: 0,
    completedEpochs: completed.length,
  };
  if (completed.length < MIN_VOTE_EPOCHS) return none;

  const mean = completed.reduce((a, b) => a + b, 0) / completed.length;
  if (mean <= 0) return none;

  const variance = completed.reduce((a, v) => a + (v - mean) ** 2, 0) / completed.length;
  const voteVolatility = Math.sqrt(variance) / mean;
  const expectedVotes = median(completed);

  const comparable = currentVotes >= minVoteBaseline && expectedVotes >= minVoteBaseline;

  return {
    expectedVotes,
    refillRatio: comparable ? expectedVotes / currentVotes : null,
    voteVolatility,
    voteStability: 1 / (1 + voteVolatility),
    completedEpochs: completed.length,
  };
}

/**
 * The vote weight a recommendation should actually divide by: the larger of
 * what the pool carries now and what it typically settles at.
 *
 * Taking the maximum rather than the typical weight is deliberate, and it is
 * conservative in *both* directions. A pool sitting below its usual weight will
 * most likely be refilled before the epoch closes, so the current figure would
 * flatter it. A pool sitting above its usual weight is already carrying that
 * weight, and you will be diluted by what is actually there — reaching for the
 * lower historical median in that case would flatter it too. The larger figure
 * is the one that cannot be wrong in the voter's favour.
 *
 * Falls back to the current weight whenever there is no usable history, so a
 * brand-new pool is neither penalised nor given a fictional baseline.
 */
export function expectedDilutedVotes(currentVotes: number, expectedVotes: number | null): number {
  if (expectedVotes === null || !Number.isFinite(expectedVotes)) return currentVotes;
  return Math.max(currentVotes, expectedVotes);
}
