import { firstBlockAtOrAfter } from "./v3.js";

/**
 * What it costs to point sAERO at a pool on each network, measured from what
 * people actually paid. Allocating from Base to another network goes through
 * Aero's RootVoter on Base, which sends one cross-chain message per network;
 * the message fee is the transaction's ETH value (measured 16.11.2026: OP
 * ~$0.70, Arbitrum ~$0.55, Ethereum ~$1.73 at ETH $1,796). Allocations that show
 * $0 there were sent by smart wallets (ERC-4337 EntryPoint) or relays, which pay
 * the fee from inside the call: they are not free, so they are left out.
 * Pools on Base itself cost only Base gas, a few cents at most.
 */
export const ROOT_VOTER = "0x49d7d4f17ec56ef8fa04e464af5d1a4942cc31e6";
/** RootVoter's per-network dispatch event; topic 2 is the destination chain id. */
export const DISPATCH_TOPIC = "0x66d2690ffceea8f4e6eb97b864441bb120b19e2c50c87420d7e5ca144c71a27e";
export const BASE_CHAIN_ID = 8453;
/** Chain ids of Aero's other networks, by the names src/v3-cli.ts uses (Robinhood and Arc read from their RPCs, 16.11.2026). */
export const NETWORK_BY_CHAIN_ID: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  42161: "arbitrum",
  57073: "ink",
  4663: "robinhood",
  5042: "arc",
};
// 6 h left Ethereum and Ink under MOVE_COST_MIN_SAMPLES (16.11.2026); a day of moves covers every network.
export const MOVE_COST_HOURS = 24;
/** Fewer paid moves than this to a network in the window and its cost is left out rather than guessed. */
export const MOVE_COST_MIN_SAMPLES = 3;
const TX_READ_CONCURRENCY = 10;
const LOG_STEP = 10_000n;

export interface MoveCost {
  /** Median fee in USD of one move to this network. */
  usd: number;
  /** Paid moves behind the median. */
  samples: number;
}

/**
 * Median paid fee per network. Only transactions that reached exactly one other
 * network count (a move to two networks pays two fees in one value), and only
 * those with a value above zero (see the note on ROOT_VOTER).
 */
export function summarizeMoveCosts(
  txs: readonly { chainIds: readonly number[]; valueWei: bigint }[],
  ethUsd: number,
  minSamples = MOVE_COST_MIN_SAMPLES,
): Record<string, MoveCost> {
  const byNetwork = new Map<string, number[]>();
  for (const t of txs) {
    const remote = [...new Set(t.chainIds.filter((id) => id !== BASE_CHAIN_ID))];
    if (remote.length !== 1 || t.valueWei <= 0n) continue;
    const name = NETWORK_BY_CHAIN_ID[remote[0]];
    if (!name) continue;
    const list = byNetwork.get(name) ?? [];
    list.push((Number(t.valueWei) / 1e18) * ethUsd);
    byNetwork.set(name, list);
  }
  const out: Record<string, MoveCost> = {};
  for (const [name, values] of byNetwork) {
    if (values.length < minSamples) continue;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    out[name] = { usd: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, samples: s.length };
  }
  return out;
}

type Hex = `0x${string}`;
interface RawLog {
  transactionHash: Hex;
  topics: Hex[];
  blockNumber: Hex;
}
/** The part of a viem public client this module uses, so tests can pass a fake. */
export interface MoveCostClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  request(a: { method: "eth_getLogs"; params: [{ address: string; topics: string[]; fromBlock: Hex; toBlock: Hex }] }): Promise<RawLog[]>;
  getTransaction(a: { hash: Hex }): Promise<{ value: bigint }>;
}

/** Median fee paid for moves out of Base over the last MOVE_COST_HOURS, per network. */
export async function readMoveCosts(c: MoveCostClient, ethUsd: number, now: Date): Promise<Record<string, MoveCost>> {
  const latest = await c.getBlockNumber();
  const from = await firstBlockAtOrAfter(c, Math.floor(now.getTime() / 1000) - MOVE_COST_HOURS * 3600, latest);
  const logs: RawLog[] = [];
  for (let b = from; b <= latest; b += LOG_STEP) {
    const to = b + LOG_STEP - 1n < latest ? b + LOG_STEP - 1n : latest;
    logs.push(
      ...(await c.request({
        method: "eth_getLogs",
        params: [{ address: ROOT_VOTER, topics: [DISPATCH_TOPIC], fromBlock: `0x${b.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      })),
    );
  }
  const byTx = new Map<Hex, { block: bigint; chainIds: number[] }>();
  for (const l of logs) {
    const t = byTx.get(l.transactionHash) ?? { block: BigInt(l.blockNumber), chainIds: [] };
    t.chainIds.push(Number(BigInt(l.topics[2])));
    byTx.set(l.transactionHash, t);
  }
  // Every single-network move of the window (~170 a day on 16.11.2026), so the median is the whole day's.
  // Read a few at a time; a lookup that fails drops only that move, not the run.
  const picked = [...byTx]
    .filter(([, t]) => new Set(t.chainIds.filter((id) => id !== BASE_CHAIN_ID)).size === 1)
    .map(([hash, t]) => ({ hash, chainIds: t.chainIds }));
  const txs: { chainIds: number[]; valueWei: bigint }[] = [];
  for (let i = 0; i < picked.length; i += TX_READ_CONCURRENCY) {
    const batch = picked.slice(i, i + TX_READ_CONCURRENCY);
    const got = await Promise.allSettled(batch.map((p) => c.getTransaction({ hash: p.hash })));
    got.forEach((r, k) => {
      if (r.status === "fulfilled") txs.push({ chainIds: batch[k].chainIds, valueWei: r.value.value });
    });
  }
  return summarizeMoveCosts(txs, ethUsd);
}
