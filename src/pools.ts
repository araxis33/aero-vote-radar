import { client } from "./chain.js";
import { POOL_ABI, REWARDS_SUGAR_ABI, VOTER_ABI } from "./abi.js";
import { REWARDS_SUGAR_ADDRESS, VOTER_ADDRESS } from "./constants.js";

export interface PoolInfo {
  address: string;
  symbol: string;
  token0: string;
  token1: string;
  gauge: string;
  gaugeAlive: boolean;
}

export interface EpochReward {
  token: string;
  amount: bigint;
}

export interface EpochData {
  ts: number;
  votes: bigint;
  bribes: EpochReward[];
  fees: EpochReward[];
}

/** The subset of viem's multicall result shape this module reads from. */
export interface MulticallOutcome {
  status: string;
  result?: unknown;
}

/**
 * Keeps only the pools (and their paired gauges) whose gauge is currently
 * alive, preserving alignment between the two arrays by index. Pure and
 * chain-free, so it's unit-testable without mocking RPC calls — unlike
 * `fetchActivePools`, which fetches live.
 */
export function filterAlivePools<TPool, TGauge>(
  poolAddresses: readonly TPool[],
  gauges: readonly TGauge[],
  aliveFlags: readonly boolean[],
): { alivePools: TPool[]; aliveGauges: TGauge[] } {
  return {
    alivePools: poolAddresses.filter((_, i) => aliveFlags[i]),
    aliveGauges: gauges.filter((_, i) => aliveFlags[i]),
  };
}

/**
 * Combines gauge-alive pools with their (possibly-failed) `symbol`/`token0`/
 * `token1` multicall results into resolved `PoolInfo` entries, skipping any
 * pool where at least one of those three calls failed rather than letting a
 * handful of non-standard/cross-chain-relay entries take down the whole
 * result. Pure and chain-free, so it's unit-testable without mocking RPC
 * calls — unlike `fetchActivePools`, which fetches live.
 */
export function resolvePoolInfo<TPool extends string, TGauge extends string>(
  alivePools: readonly TPool[],
  aliveGauges: readonly TGauge[],
  symbols: readonly MulticallOutcome[],
  token0s: readonly MulticallOutcome[],
  token1s: readonly MulticallOutcome[],
): { pools: PoolInfo[]; skipped: number } {
  const pools: PoolInfo[] = [];
  let skipped = 0;

  alivePools.forEach((pool, i) => {
    if (symbols[i].status !== "success" || token0s[i].status !== "success" || token1s[i].status !== "success") {
      skipped++;
      return;
    }
    pools.push({
      address: pool,
      symbol: symbols[i].result as string,
      token0: token0s[i].result as string,
      token1: token1s[i].result as string,
      gauge: aliveGauges[i],
      gaugeAlive: true,
    });
  });

  return { pools, skipped };
}

/**
 * Pools that currently have a live voting gauge. Enumerates via Voter (the
 * contract that actually gatekeeps voting) rather than LpSugar's `all()`, which
 * scans every pool the factory has ever created (~28k, almost all irrelevant to
 * voting) — see the comment on VOTER_ABI for why this matters in practice.
 */
export async function fetchActivePools(): Promise<PoolInfo[]> {
  const length = await client.readContract({
    address: VOTER_ADDRESS,
    abi: VOTER_ABI,
    functionName: "length",
  });

  const indices = Array.from({ length: Number(length) }, (_, i) => BigInt(i));

  const poolAddresses = await client.multicall({
    contracts: indices.map(
      (i) =>
        ({
          address: VOTER_ADDRESS,
          abi: VOTER_ABI,
          functionName: "pools",
          args: [i],
        }) as const,
    ),
    allowFailure: false,
  });

  const gauges = await client.multicall({
    contracts: poolAddresses.map(
      (pool) =>
        ({
          address: VOTER_ADDRESS,
          abi: VOTER_ABI,
          functionName: "gauges",
          args: [pool],
        }) as const,
    ),
    allowFailure: false,
  });

  const aliveFlags = await client.multicall({
    contracts: gauges.map(
      (gauge) =>
        ({
          address: VOTER_ADDRESS,
          abi: VOTER_ABI,
          functionName: "isAlive",
          args: [gauge],
        }) as const,
    ),
    allowFailure: false,
  });

  const { alivePools, aliveGauges } = filterAlivePools(poolAddresses, gauges, aliveFlags);

  // Read symbol/token0/token1 straight off each pool contract (every Aerodrome
  // pool is itself an ERC20-like LP token) rather than via LpSugar.byAddress,
  // which internally linear-scans up to 30,000 pools per call and reliably runs
  // out of gas on a public RPC's default eth_call allowance.
  const [symbols, token0s, token1s] = await Promise.all([
    client.multicall({
      contracts: alivePools.map((pool) => ({ address: pool, abi: POOL_ABI, functionName: "symbol" }) as const),
      allowFailure: true,
    }),
    client.multicall({
      contracts: alivePools.map((pool) => ({ address: pool, abi: POOL_ABI, functionName: "token0" }) as const),
      allowFailure: true,
    }),
    client.multicall({
      contracts: alivePools.map((pool) => ({ address: pool, abi: POOL_ABI, functionName: "token1" }) as const),
      allowFailure: true,
    }),
  ]);

  const { pools: resolved, skipped } = resolvePoolInfo(alivePools, aliveGauges, symbols, token0s, token1s);

  if (skipped > 0) {
    console.error(`(skipped ${skipped} voter-registered pool(s) whose contract calls failed — likely non-standard/cross-chain entries)`);
  }

  return resolved;
}

/** Trailing weekly epoch history for one pool, most recent first (as returned by the contract). */
export async function fetchPoolEpochs(pool: string, limit: number): Promise<EpochData[]> {
  const epochs = await client.readContract({
    address: REWARDS_SUGAR_ADDRESS,
    abi: REWARDS_SUGAR_ABI,
    functionName: "epochsByAddress",
    args: [BigInt(limit), 0n, pool as `0x${string}`],
  });

  return epochs.map((e) => ({
    ts: Number(e.ts),
    votes: e.votes,
    bribes: e.bribes.map((b) => ({ token: b.token, amount: b.amount })),
    fees: e.fees.map((f) => ({ token: f.token, amount: f.amount })),
  }));
}
