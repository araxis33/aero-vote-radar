import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getTokenPrices, toUsd } from "../src/prices.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test("getTokenPrices returns looked-up price/decimals on a successful response", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        coins: { "base:0xaaa": { price: 2.5, decimals: 6, symbol: "AAA" } },
      }),
    })) as typeof fetch;

  const prices = await getTokenPrices(["0xAAA"]);
  assert.deepEqual(prices.get("0xaaa"), { price: 2.5, decimals: 6 });
});

test("getTokenPrices falls back to price 0 on a non-ok HTTP response", async () => {
  global.fetch = (async () => ({ ok: false })) as typeof fetch;

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

test("toUsd converts a raw token amount using the looked-up price/decimals", () => {
  const prices = new Map([["0xddd1", { price: 2, decimals: 6 }]]);
  assert.equal(toUsd(3_000_000n, "0xDDD1", prices), 6);
});

test("toUsd returns 0 for a token with no price info or an explicit price of 0", () => {
  const prices = new Map([["0xeee1", { price: 0, decimals: 18 }]]);
  assert.equal(toUsd(1_000_000n, "0xeee1", prices), 0);
  assert.equal(toUsd(1_000_000n, "0xnotpriced", prices), 0);
});
