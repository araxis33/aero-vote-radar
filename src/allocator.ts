import type { PoolEfficiency } from "./efficiency.js";

export interface AllocationResult {
  pool: string;
  symbol: string;
  weight: number;
  veAeroAllocated: number;
  expectedUsd: number;
}

interface Candidate {
  address: string;
  symbol: string;
  existingVotes: number;
  expectedUsd: number;
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
  // Reject non-finite budgets (e.g. a caller passing Infinity/NaN through) rather
  // than letting `stepSize` become Infinity/NaN and poisoning every allocation
  // below with NaN weights and expected-USD values.
  if (!Number.isFinite(veAeroBudget) || veAeroBudget <= 0) return [];

  const candidates: Candidate[] = ranked.slice(0, topK).map((c) => ({
    address: c.pool.address,
    symbol: c.pool.symbol,
    existingVotes: c.currentVotesVeAero,
    expectedUsd: c.trailingAvgUsd,
    allocated: 0,
  }));

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
