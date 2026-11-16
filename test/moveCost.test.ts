import { test } from "node:test";
import assert from "node:assert/strict";
import { readMoveCosts, summarizeMoveCosts, ROOT_VOTER, type MoveCostClient } from "../src/moveCost.js";

const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

test("summarizeMoveCosts: median per network in USD, single-network paid moves only", () => {
  const out = summarizeMoveCosts(
    [
      { chainIds: [10], valueWei: eth(0.0003) },
      { chainIds: [10], valueWei: eth(0.0005) },
      { chainIds: [10], valueWei: eth(0.0004) },
      // $0: a smart wallet or relay paid from inside the call — not free, left out
      { chainIds: [10], valueWei: 0n },
      // two networks in one value — can't split it, left out
      { chainIds: [10, 42161], valueWei: eth(0.01) },
      // Base itself is not a move to another network
      { chainIds: [8453, 10], valueWei: eth(0.0004) },
    ],
    2000,
  );
  assert.deepEqual(Object.keys(out), ["optimism"]);
  assert.equal(out.optimism.samples, 4);
  assert.ok(Math.abs(out.optimism.usd - 0.8) < 1e-9); // median of 0.6, 0.8, 0.8, 1.0
});

test("summarizeMoveCosts: too few paid moves or an unknown network → no figure", () => {
  const out = summarizeMoveCosts(
    [
      { chainIds: [1], valueWei: eth(0.001) },
      { chainIds: [1], valueWei: eth(0.001) },
      { chainIds: [99901], valueWei: eth(0.001) },
      { chainIds: [99901], valueWei: eth(0.001) },
      { chainIds: [99901], valueWei: eth(0.001) },
    ],
    2000,
  );
  assert.deepEqual(out, {});
});

test("readMoveCosts: reads the RootVoter window and the value of each move", async () => {
  const topic = (id: number) => ("0x" + id.toString(16).padStart(64, "0")) as `0x${string}`;
  const logs = [
    { transactionHash: "0xa", blockNumber: "0x10", topics: ["0x0", "0x0", topic(42161)] },
    { transactionHash: "0xb", blockNumber: "0x11", topics: ["0x0", "0x0", topic(42161)] },
    { transactionHash: "0xc", blockNumber: "0x12", topics: ["0x0", "0x0", topic(42161)] },
  ];
  const values: Record<string, bigint> = { "0xa": eth(0.0002), "0xb": eth(0.0003), "0xc": eth(0.0004) };
  let asked: unknown;
  const c = {
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_000_000n + blockNumber }),
    request: async (a: { params: [{ address: string }] }) => {
      asked = a.params[0].address;
      return logs;
    },
    getTransaction: async ({ hash }: { hash: string }) => ({ value: values[hash] }),
  } as unknown as MoveCostClient;
  const out = await readMoveCosts(c, 2000, new Date(1_000_100 * 1000));
  assert.equal(asked, ROOT_VOTER);
  assert.deepEqual(out, { arbitrum: { usd: 0.6, samples: 3 } });
});

test("readMoveCosts: the whole window counts, $0 moves and failed lookups drop only themselves", async () => {
  const topic = (id: number) => ("0x" + id.toString(16).padStart(64, "0")) as `0x${string}`;
  // 40 paid moves at 0.0005 ETH, then 30 newer $0 moves and one lookup that fails.
  const logs = Array.from({ length: 71 }, (_, i) => ({ transactionHash: "0x" + i.toString(16), blockNumber: "0x" + (i + 1).toString(16), topics: ["0x0", "0x0", topic(10)] }));
  const c = {
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_000_000n + blockNumber }),
    request: async () => logs,
    getTransaction: async ({ hash }: { hash: string }) => {
      const i = parseInt(hash, 16);
      if (i === 70) throw new Error("rate limited");
      return { value: i < 40 ? eth(0.0005) : 0n };
    },
  } as unknown as MoveCostClient;
  const out = await readMoveCosts(c, 2000, new Date(1_000_100 * 1000));
  assert.deepEqual(out, { optimism: { usd: 1, samples: 40 } });
});
