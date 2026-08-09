import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getTokenPrices, toUsd } from "../src/prices.js";
import { DEFILLAMA_TIMEOUT_MS, PRICE_CACHE_TTL_MS } from "../src/constants.js";

const originalFetch = global.fetch;
const originalNow = Date.now;
const originalAbortTimeout = AbortSignal.timeout;

afterEach(() => {
  global.fetch = originalFetch;
  Date.now = originalNow;
  AbortSignal.timeout = originalAbortTimeout;
});

test("getTokenPrices returns looked-up price/decimals on a successful response", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        coins: { "base:0xaaa": { price: 2.5, decimals: 6, symbol: "AAA" } },
      }),
    })) as unknown as typeof fetch;

  const prices = await getTokenPrices(["0xAAA"]);
  assert.deepEqual(prices.get("0xaaa"), { price: 2.5, decimals: 6 });
});

test("getTokenPrices falls back to price 0 on a non-ok HTTP response", async () => {
  global.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;

  const prices = await getTokenPrices(["0xBBB1"]);
  assert.deepEqual(prices.get("0xbbb1"), { price: 0, decimals: 18 });
});

test("getTokenPrices falls back to price 0 rather than throwing when fetch itself rejects (DNS/timeout/connection failure)", async () => {
  global.fetch = (async () => {
    throw new Error("network failure");
  }) as typeof fetch;

  const prices = await getTokenPrices(["0xCCC1"]);
  assert.deepEqual(prices.get("0xccc1"), { price: 0, decimals: 18 });
});

test("getTokenPrices passes an abort signal so a stalled request can't hang the batch forever", async () => {
  let receivedSignal: AbortSignal | undefined;
  global.fetch = (async (_url: string, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined;
    return { ok: true, json: async () => ({ coins: {} }) };
  }) as typeof fetch;

  await getTokenPrices(["0xsignalcheck"]);

  assert.ok(receivedSignal instanceof AbortSignal, "fetch should receive an AbortSignal");
});

test("getTokenPrices falls back to price 0 rather than hanging when the request stalls past the timeout", async () => {
  // Stub AbortSignal.timeout to fire immediately instead of waiting out the real
  // DEFILLAMA_TIMEOUT_MS, so this test verifies the stall-handling wiring without
  // actually taking that long to run.
  AbortSignal.timeout = () => originalAbortTimeout.call(AbortSignal, 0);

  global.fetch = (async (_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
    });
  }) as typeof fetch;

  const prices = await getTokenPrices(["0xstalled1"]);
  assert.deepEqual(prices.get("0xstalled1"), { price: 0, decimals: 18 });
});

test("toUsd converts a raw token amount using the looked-up price/decimals", () => {
  const prices = new Map([["0xddd1", { price: 2, decimals: 6 }]]);
  assert.equal(toUsd(3_000_000n, "0xDDD1", prices), 6);
});

test("toUsd returns 0 for a token with no price info or an explicit price of 0", () => {
  const prices = new Map([["0xeee1", { price: 0, decimals: 18 }]]);
  assert.equal(toUsd(1_000_000n, "0xeee1", prices), 0);
  assert.equal(toUsd(1_000_000n, "0xnotpriced", prices), 0);
});

test("getTokenPrices splits a large token list into multiple batched requests", async () => {
  const calls: string[][] = [];
  global.fetch = (async (url: string) => {
    const keys = url.toString().split("/prices/current/")[1].split(",");
    calls.push(keys);
    return {
      ok: true,
      json: async () => ({
        coins: Object.fromEntries(keys.map((k) => [k, { price: 1, decimals: 18, symbol: "X" }])),
      }),
    };
  }) as typeof fetch;

  // 120 unique tokens with a batch size of 50 should split into 3 requests (50/50/20).
  const tokens = Array.from({ length: 120 }, (_, i) => `0xbatch${i.toString().padStart(4, "0")}`);
  const prices = await getTokenPrices(tokens);

  assert.equal(calls.length, 3, `expected 3 batched requests, got ${calls.length}`);
  assert.equal(calls[0].length, 50);
  assert.equal(calls[1].length, 50);
  assert.equal(calls[2].length, 20);
  for (const t of tokens) assert.equal(prices.get(t.toLowerCase())?.price, 1);
});

test("getTokenPrices reuses a fresh cached price instead of refetching", async () => {
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({ coins: { "base:0xfresh1": { price: 7, decimals: 18, symbol: "X" } } }),
    };
  }) as unknown as typeof fetch;

  let now = 1_000_000;
  Date.now = () => now;

  await getTokenPrices(["0xFRESH1"]);
  now += PRICE_CACHE_TTL_MS - 1; // still within TTL
  const second = await getTokenPrices(["0xFRESH1"]);

  assert.equal(calls, 1, "second lookup within TTL should reuse the cached price, not refetch");
  assert.deepEqual(second.get("0xfresh1"), { price: 7, decimals: 18 });
});

test("getTokenPrices refetches once a cached price has aged past the TTL", async () => {
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    const price = calls === 1 ? 7 : 9;
    return {
      ok: true,
      json: async () => ({ coins: { "base:0xstale1": { price, decimals: 18, symbol: "X" } } }),
    };
  }) as unknown as typeof fetch;

  let now = 1_000_000;
  Date.now = () => now;

  const first = await getTokenPrices(["0xSTALE1"]);
  now += PRICE_CACHE_TTL_MS + 1; // past TTL
  const second = await getTokenPrices(["0xSTALE1"]);

  assert.equal(calls, 2, "lookup past TTL should refetch rather than serve the stale cached price");
  assert.deepEqual(first.get("0xstale1"), { price: 7, decimals: 18 });
  assert.deepEqual(second.get("0xstale1"), { price: 9, decimals: 18 });
});

test("getTokenPrices: a failed batch only zeroes out that batch's tokens, not other batches'", async () => {
  global.fetch = (async (url: string) => {
    const keys = url.toString().split("/prices/current/")[1].split(",");
    if (keys[0].includes("failbatch")) throw new Error("network failure");
    return {
      ok: true,
      json: async () => ({
        coins: Object.fromEntries(keys.map((k) => [k, { price: 3, decimals: 18, symbol: "X" }])),
      }),
    };
  }) as typeof fetch;

  const goodTokens = Array.from({ length: 50 }, (_, i) => `0xgoodbatch${i.toString().padStart(4, "0")}`);
  const badTokens = Array.from({ length: 50 }, (_, i) => `0xfailbatch${i.toString().padStart(4, "0")}`);
  const prices = await getTokenPrices([...goodTokens, ...badTokens]);

  for (const t of goodTokens) assert.equal(prices.get(t.toLowerCase())?.price, 3, `${t} should be priced from its own batch`);
  for (const t of badTokens) assert.equal(prices.get(t.toLowerCase())?.price, 0, `${t} should fall back to 0`);
});
