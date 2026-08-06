import type { PoolEfficiency } from "./efficiency.js";

export interface AllocationResult {
  pool: string;
  symbol: string;
  weight: number;
  veAeroAllocated: number;
  expectedUsd: number;
}

export interface WholePercentWeight {
  pool: string;
  symbol: string;
  percent: number;
}

/**
 * Rewrites fractional allocation weights as whole percentages that sum to
 * exactly 100, which is the form Aerodrome's own voting UI actually accepts.
 *
 * Rounding each weight independently doesn't work: six weights of 16.67% each
 * round to 17% and total 102%, which the UI rejects — so the user ends up
 * hand-fudging the last row and quietly voting something other than what was
 * recommended. This uses the largest-remainder (Hamilton) method instead: floor
 * everything, then hand the leftover percentage points one at a time to whoever
 * lost the most to flooring. Weights are normalised by their own sum first, so
 * the leftover is always between 0 and the number of candidates even if the
 * incoming weights carry floating-point drift.
 *
 * Rows that land on 0% are dropped — you cannot cast a 0% vote — and dropping
 * them is safe precisely because they contribute nothing to the 100 total.
 */
export function toWholePercentWeights(allocation: AllocationResult[]): WholePercentWeight[] {
  const totalWeight = allocation.reduce((a, b) => a + b.weight, 0);
  if (allocation.length === 0 || totalWeight <= 0) return [];

  const rows = allocation.map((a) => {
    const raw = (a.weight / totalWeight) * 100;
    const floor = Math.floor(raw);
    return { pool: a.pool, symbol: a.symbol, percent: floor, remainder: raw - floor };
  });

  let deficit = 100 - rows.reduce((a, b) => a + b.percent, 0);

  // Hand out the leftover points to the largest fractional remainders. Ties fall
  // back to the incoming order, which the allocator already sorted by size, so
  // the result is deterministic rather than dependent on sort stability.
  const byRemainder = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.remainder - a.row.remainder || a.index - b.index);

  for (const { row } of byRemainder) {
    if (deficit <= 0) break;
    row.percent++;
    deficit--;
  }

  return rows
    .filter((r) => r.percent > 0)
    .map(({ pool, symbol, percent }) => ({ pool, symbol, percent }));
}

/**
 * The minimal shape the allocator actually needs. Stated as its own type so
 * callers that aren't holding a full `PoolEfficiency` — notably the backtester,
 * which reconstructs each historical epoch's view of the world — can run the
 * real allocation algorithm instead of reimplementing it and drifting from it.
 */
export interface AllocationCandidate {
  address: string;
  symbol: string;
  existingVotes: number;
  expectedUsd: number;
}

interface Candidate extends AllocationCandidate {
  allocated: number;
}

/**
 * Greedy marginal-value ("water-filling") allocator. Repeatedly gives the next
 * small slice of the veAERO budget to whichever candidate pool currently has the
 * highest marginal expected return, where a pool's expected epoch value R is held
 * fixed at its trailing-average estimate and other voters' votes V are held fixed
 * at their last-observed snapshot (a stated simplifying assumption — this does not
 * model how other voters might react to your allocation).
 *
 * For a pool, your dollar return if you hold x of its (V + x) total votes is
 * R * x / (V + x); its derivative w.r.t. x is R * V / (V + x)^2, which strictly
 * decreases as you add more of your own votes — this is the self-dilution effect
 * naive "just vote where APR is highest" optimizers ignore.
 */
export function recommendAllocation(
  ranked: PoolEfficiency[],
  veAeroBudget: number,
  topK = 15,
  steps = 400,
): AllocationResult[] {
  return allocateAcrossCandidates(
    ranked.slice(0, topK).map((c) => ({
      address: c.pool.address,
      symbol: c.pool.symbol,
      existingVotes: c.currentVotesVeAero,
      expectedUsd: c.trailingAvgUsd,
    })),
    veAeroBudget,
    steps,
  );
}

/**
 * The allocation algorithm itself, over an already-selected candidate set. See
 * `recommendAllocation` for the maths and the assumptions it rests on.
 */
export function allocateAcrossCandidates(
  input: AllocationCandidate[],
  veAeroBudget: number,
  steps = 400,
): AllocationResult[] {
  // Reject non-finite budgets (e.g. a caller passing Infinity/NaN through) rather
  // than letting `stepSize` become Infinity/NaN and poisoning every allocation
  // below with NaN weights and expected-USD values.
  if (!Number.isFinite(veAeroBudget) || veAeroBudget <= 0) return [];

  const candidates: Candidate[] = input.map((c) => ({ ...c, allocated: 0 }));

  const stepSize = veAeroBudget / steps;

  for (let s = 0; s < steps; s++) {
    let bestIndex = -1;
    let bestMarginal = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const v = c.existingVotes + c.allocated;
      const marginal = c.expectedUsd > 0 ? (c.expectedUsd * c.existingVotes) / (v * v) : 0;
      if (marginal > bestMarginal) {
        bestMarginal = marginal;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) break; // no candidate has any positive expected value left
    candidates[bestIndex].allocated += stepSize;
  }

  return candidates
    .filter((c) => c.allocated > 0)
    .map((c) => ({
      pool: c.address,
      symbol: c.symbol,
      weight: c.allocated / veAeroBudget,
      veAeroAllocated: c.allocated,
      expectedUsd: (c.expectedUsd * c.allocated) / (c.existingVotes + c.allocated),
    }))
    .sort((a, b) => b.veAeroAllocated - a.veAeroAllocated);
}
