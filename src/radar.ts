import type { V3ScanFile, V3ScanGauge } from "./v3.js";
import { isSteady } from "./v3History.js";

/**
 * The same figures the web page shows, for the CLI and the MCP server. Both read
 * the hourly scan the page reads (src/v3-cli.ts → docs/data/v3.json), so a pool
 * ranks the same everywhere and an answer takes a second instead of the two
 * minutes a fresh scan of seven networks takes.
 */
export const DEFAULT_DATA_URL = process.env.AERO_RADAR_DATA_URL ?? "https://aero.deftools.xyz/data/v3.json";

/** Below this much sAERO allocated, one stake moves the pool's rate; the page leaves such pools out too. */
export const MIN_WEIGHT = 100_000;
/** A split longer than this is no longer something to type into Aero's Allocate page by hand. */
export const MAX_POOLS = 3;
/** 5% steps. */
export const SPLIT_STEPS = 20;
/** The split is searched over this many of the best pools before being cut to MAX_POOLS. */
export const SPLIT_CANDIDATES = 15;
/** A scan older than this is flagged: the hourly job has stopped or is late. */
export const STALE_HOURS = 3;
export const FETCH_TIMEOUT_MS = 15_000;

export const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  ethereum: "Ethereum",
  optimism: "OP Mainnet",
  arbitrum: "Arbitrum",
  ink: "Ink",
  robinhood: "Robinhood Chain",
  arc: "Arc",
};

export const chainOf = (g: Pick<V3ScanGauge, "chain">) => g.chain || "base";
export const chainName = (chain: string) => CHAIN_NAMES[chain] ?? chain;
export const poolName = (g: Pick<V3ScanGauge, "symbol0" | "symbol1" | "pool">) =>
  g.symbol0 ? `${g.symbol0}/${g.symbol1}` : `${g.pool.slice(0, 6)}…${g.pool.slice(-4)}`;
/** Fees over the scan window plus incentives streaming now, per day, for the whole pool. */
export const perDay = (g: Pick<V3ScanGauge, "feesUsdPerDay" | "incentivesUsdPerDay">) => g.feesUsdPerDay + g.incentivesUsdPerDay;

/** What `amount` sAERO earns a day in a pool paying `usdPerDay` to `weight` sAERO, once it joins them. */
export function dilutedPerDay(usdPerDay: number, weight: number, amount: number): number {
  return amount > 0 ? (usdPerDay * amount) / (weight + amount) : 0;
}

export async function fetchScan(url: string = DEFAULT_DATA_URL): Promise<V3ScanFile> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Could not load the Aero scan from ${url} (HTTP ${res.status}).`);
  let scan: V3ScanFile;
  try {
    scan = (await res.json()) as V3ScanFile;
  } catch (err) {
    // A 200 with a body that isn't JSON (a CDN/host error page, a truncated
    // response from a dropped connection) would otherwise surface as a bare
    // SyntaxError — "Unexpected token '<'…" — with no hint of which URL or
    // request it came from, unlike every other failure path here.
    throw new Error(`The Aero scan at ${url} did not return valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (scan.status !== "live" || !Array.isArray(scan.gauges) || scan.gauges.length === 0) {
    throw new Error(`The Aero scan at ${url} has no live pools (status: ${scan.status}).`);
  }
  return scan;
}

/** Hours since the scan was taken. */
export const scanAgeHours = (scan: Pick<V3ScanFile, "checkedAt">, nowMs: number = Date.now()) =>
  Math.max(0, (nowMs - Date.parse(scan.checkedAt)) / 3_600_000);

export interface RankedPool {
  gauge: V3ScanGauge;
  /** What `amount` earns a day here after diluting the pool. */
  mine: number;
}

/** Pools worth ranking, best for `amount` first, optionally on one network. */
export function rankPools(scan: V3ScanFile, amount: number, chain?: string): RankedPool[] {
  return scan.gauges
    .filter((g) => g.weight >= MIN_WEIGHT && perDay(g) > 0 && (!chain || chainOf(g) === chain))
    .map((g) => ({ gauge: g, mine: dilutedPerDay(perDay(g), g.weight, amount) }))
    .sort((a, b) => b.mine - a.mine);
}

export interface SplitRow {
  gauge: V3ScanGauge;
  /** Fraction of `amount`, a multiple of 1 / SPLIT_STEPS. */
  share: number;
  amount: number;
  perDay: number;
}

/**
 * Greedy in 5% steps: each step goes where it adds the most after dilution,
 * then the split is redone over the top MAX_POOLS so it stays short enough to
 * enter by hand. `pools` must already be ranked (rankPools).
 */
export function splitAllocation(pools: readonly V3ScanGauge[], amount: number): SplitRow[] {
  const run = (cands: readonly V3ScanGauge[]) => {
    const alloc = new Map(cands.map((g) => [g, 0]));
    const step = amount / SPLIT_STEPS;
    for (let i = 0; i < SPLIT_STEPS; i++) {
      let best = cands[0];
      let gain = -1;
      for (const g of cands) {
        const a = alloc.get(g)!;
        const d = dilutedPerDay(perDay(g), g.weight, a + step) - dilutedPerDay(perDay(g), g.weight, a);
        if (d > gain) {
          gain = d;
          best = g;
        }
      }
      alloc.set(best, alloc.get(best)! + step);
    }
    return [...alloc].filter(([, a]) => a > 0).sort((x, y) => y[1] - x[1]);
  };
  if (!(amount > 0) || pools.length === 0) return [];
  let out = run(pools.slice(0, SPLIT_CANDIDATES));
  if (out.length > MAX_POOLS) out = run(out.slice(0, MAX_POOLS).map(([g]) => g));
  return out.map(([g, a]) => ({ gauge: g, share: a / amount, amount: a, perDay: dilutedPerDay(perDay(g), g.weight, a) }));
}

/** Last 24 h of fees against the whole window: "new" until there are 36 h behind the figures. */
export function trendOf(g: V3ScanGauge, windowHours: number): { label: "new" | "rising" | "cooling" | "steady"; change?: number } {
  if (windowHours < 36 || !(g.feesUsdPerDay > 0)) return { label: "new" };
  const change = g.fees24hUsdPerDay / g.feesUsdPerDay - 1;
  if (change > 0.1) return { label: "rising", change };
  if (change < -0.1) return { label: "cooling", change };
  return { label: "steady", change };
}

/** Same pay as rankPools and the page (fees over the scan window plus incentives), so one pool never shows two prices. */
export const steadyNow = (g: V3ScanGauge, amount: number) => dilutedPerDay(perDay(g), g.weight, amount);

/** Pools that kept paying hour after hour (src/v3History.ts), ranked by what they pay `amount` now. */
export function steadyPools(scan: V3ScanFile, amount: number, chain?: string): RankedPool[] {
  return scan.gauges
    .filter((g) => g.weight >= MIN_WEIGHT && perDay(g) > 0 && isSteady(g.steady) && (!chain || chainOf(g) === chain))
    .map((g) => ({ gauge: g, mine: steadyNow(g, amount) }))
    .sort((a, b) => b.mine - a.mine);
}

/** One pool as the CLI's --json and the MCP tools return it. */
export function poolToJson(g: V3ScanGauge, windowHours: number, amount: number) {
  const trend = trendOf(g, windowHours);
  return {
    pool: poolName(g),
    kind: g.kind ?? null,
    chain: chainOf(g),
    poolAddress: g.pool,
    gauge: g.gauge,
    yourUsdPerDay: dilutedPerDay(perDay(g), g.weight, amount),
    poolFeesUsdPerDay: g.feesUsdPerDay,
    poolFees24hUsdPerDay: g.fees24hUsdPerDay,
    poolIncentivesUsdPerDay: g.incentivesUsdPerDay,
    allocatedSAero: g.weight,
    trend: trend.label,
    trendChange: trend.change ?? null,
    steady: isSteady(g.steady) ? g.steady! : null,
  };
}

/** The suggested split as text to keep beside Aero's Allocate page. */
export function splitToText(split: readonly SplitRow[]): string {
  return split.map((s) => `${poolName(s.gauge)} (${s.gauge.kind ?? "?"}, ${chainName(chainOf(s.gauge))}) ${Math.round(s.share * 100)}%`).join("\n");
}

export const ALLOCATE_URL = "https://app.aero.xyz/markets/allocate";

/** Hours a stake must hold a network before it can move again (Aero's per-network allocation cooldown). */
export const ALLOCATION_HOLD_HOURS = 47;

export interface MoveInCost {
  /** Total one-time fee, in USD, to reach every network outside Base the split uses. */
  usd: number;
  /** Networks outside Base the split pays a fee to reach. */
  chains: string[];
}

/**
 * The one-time fee (src/moveCost.ts) to move a stake from Base into every network
 * outside Base a split reaches — one fee per network, however many of its pools
 * are in the split. `null` when the scan has no fee for one of those networks yet,
 * same as a pool's own price can be missing: the cost isn't zero, it's unknown, and
 * the two shouldn't be shown the same way.
 */
export function moveInCost(split: readonly Pick<SplitRow, "gauge">[], scan: Pick<V3ScanFile, "moveCostUsd">): MoveInCost | null {
  const chains = [...new Set(split.map((s) => chainOf(s.gauge)))].filter((c) => c !== "base");
  let usd = 0;
  for (const c of chains) {
    const fee = scan.moveCostUsd?.[c]?.usd;
    if (fee === undefined) return null;
    usd += fee;
  }
  return { usd, chains };
}

/**
 * `splitAllocation`, but a network outside Base stays in the split only if what
 * it's given there earns back that network's one-time move-in fee
 * (src/moveCost.ts) within ALLOCATION_HOLD_HOURS — the same check the web page
 * already makes before suggesting a split (docs/index.html's arSteadySplit,
 * since 17.11.2026), which `recommend`/`recommend_allocation` never picked up:
 * without it, a small stake could be told to move onto a network whose fee
 * outweighed what the pool paid back before the stake could move again. A
 * network with no fee figure yet is left out rather than assumed free, same as
 * `moveInCost` treats it as unknown rather than zero.
 */
export function splitAllocationWithMoveCost(
  pools: readonly V3ScanGauge[],
  amount: number,
  moveCostUsd: V3ScanFile["moveCostUsd"],
): SplitRow[] {
  const feeOf = (chain: string): number | undefined => (chain === "base" ? 0 : moveCostUsd?.[chain]?.usd);
  let candidates = pools.filter((g) => feeOf(chainOf(g)) !== undefined);
  for (;;) {
    const split = splitAllocation(candidates, amount);
    if (split.length === 0) return split;
    const earned = new Map<string, number>();
    for (const s of split) earned.set(chainOf(s.gauge), (earned.get(chainOf(s.gauge)) ?? 0) + s.perDay * (ALLOCATION_HOLD_HOURS / 24));
    const losing = [...earned].filter(([c, paid]) => !(paid > feeOf(c)!)).map(([c]) => c);
    if (losing.length === 0) return split;
    candidates = candidates.filter((g) => !losing.includes(chainOf(g)));
  }
}

/** How long it takes `perDay` to earn back `cost`, as text; "" when `perDay` isn't positive. */
export function paybackText(cost: number, perDay: number): string {
  if (!(perDay > 0)) return "";
  const hours = (cost / perDay) * 24;
  if (hours < 1) return "under 1 h";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}
