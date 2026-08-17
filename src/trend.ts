/**
 * Weekly epoch length in seconds. Aerodrome's voting epochs are exactly one
 * week long and flip at Thursday 00:00 UTC, which falls out of the arithmetic
 * for free: the Unix epoch itself began on a Thursday, so any timestamp floored
 * to a 604800-second boundary *is* a Thursday 00:00 UTC.
 */
export const EPOCH_SECONDS = 604_800;

/**
 * Fewest completed epochs needed before a momentum figure is reported at all.
 * Momentum compares a recent half against an older half, so four is the
 * smallest history that gives each side two observations. With one observation
 * per side a single one-off bribe reads as a trend, which is exactly the
 * mistake `consistency` already exists to guard against.
 */
export const MOMENTUM_MIN_EPOCHS = 4;

/** Start timestamp of the epoch that `unixSeconds` falls inside. */
export function epochStartOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / EPOCH_SECONDS) * EPOCH_SECONDS;
}

/**
 * Whether a pool's newest epoch is the one still running.
 *
 * This matters more than it looks. `RewardsSugar.epochsByAddress` returns the
 * *current* epoch at index 0, not the most recently completed one, so on a scan
 * taken mid-week that entry holds a few days of bribes and fees rather than a
 * full week's worth. Charting it next to six finished epochs would draw a cliff
 * on every single pool, and averaging it into a "recent" half would report the
 * whole market as fading every week. So the series is published in full and
 * this flag tells consumers which bar is not comparable to the others yet.
 */
export function isEpochInProgress(latestEpochTs: number, asOfUnixSeconds: number): boolean {
  return latestEpochTs >= epochStartOf(asOfUnixSeconds);
}

export interface Trend {
  /**
   * Recent completed epochs' average value divided by the older ones', minus 1.
   * `0.4` means incentives in the recent half ran 40% above the older half.
   * Null when there is no honest basis for the comparison — see `computeTrend`.
   */
  momentum: number | null;
  /** How many completed epochs the figure was drawn from (the in-progress one excluded). */
  completedEpochs: number;
}

const average = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Splits a pool's epoch history down the middle and asks whether the recent
 * half paid better than the older half.
 *
 * This answers a question the existing metrics genuinely cannot. `trailingAvgUsd`
 * flattens six epochs into one number, and `consistency` says how *evenly* they
 * were spread — but a pool ramping from $50 to $500 and one decaying from $500
 * to $50 can report an identical average and an identical consistency. Direction
 * was simply not in the published data.
 *
 * `epochUsd` is most-recent-first, matching the contract's own ordering.
 *
 * Null momentum means "no comparable baseline", and there are two ways to get
 * there: too little completed history, or an older half that paid nothing at
 * all. The second case is deliberately not reported as infinite growth — a pool
 * that went from $0 to $500 once is a brand-new incentive programme, not an
 * established uptrend, and putting it at the top of a "ramping up" list would
 * promote exactly the unproven pools the rest of this tool is careful about.
 *
 * An odd number of completed epochs drops the middle one rather than assigning
 * it to a side, so both halves always carry equal weight.
 */
export function computeTrend(epochUsd: number[], currentEpochPartial: boolean): Trend {
  const completed = currentEpochPartial ? epochUsd.slice(1) : epochUsd.slice();
  if (completed.length < MOMENTUM_MIN_EPOCHS) {
    return { momentum: null, completedEpochs: completed.length };
  }

  const half = Math.floor(completed.length / 2);
  const recentAvg = average(completed.slice(0, half));
  const olderAvg = average(completed.slice(completed.length - half));
  if (olderAvg <= 0) return { momentum: null, completedEpochs: completed.length };

  return { momentum: recentAvg / olderAvg - 1, completedEpochs: completed.length };
}
