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

  const alivePools = poolAddresses.filter((_, i) => aliveFlags[i]);
  const aliveGauges = gauges.filter((_, i) => aliveFlags[i]);

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

  const resolved: PoolInfo[] = [];
  let skipped = 0;

  alivePools.forEach((pool, i) => {
    if (symbols[i].status !== "success" || token0s[i].status !== "success" || token1s[i].status !== "success") {
      skipped++;
      return;
    }
    resolved.push({
      address: pool,
      symbol: symbols[i].result,
      token0: token0s[i].result,
      token1: token1s[i].result,
      gauge: aliveGauges[i],
      gaugeAlive: true,
    });
  });

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
