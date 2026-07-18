import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAddress, mapWithConcurrency } from "../src/util.js";

test("isValidAddress accepts a well-formed 0x-prefixed 40-hex-character address", () => {
  assert.equal(isValidAddress("0x1234567890abcdef1234567890ABCDEF12345678"), true);
});

test("isValidAddress rejects a missing 0x prefix", () => {
  assert.equal(isValidAddress("1234567890abcdef1234567890abcdef12345678"), false);
});

test("isValidAddress rejects the wrong length", () => {
  assert.equal(isValidAddress("0x1234"), false);
  assert.equal(isValidAddress("0x1234567890abcdef1234567890abcdef123456789"), false);
});

test("isValidAddress rejects non-hex characters", () => {
  assert.equal(isValidAddress("0xzzzz567890abcdef1234567890abcdef12345678"), false);
});

test("mapWithConcurrency preserves input order regardless of completion order", async () => {
  // Earlier items resolve slower than later ones, so this only passes if results
  // are written to their original index rather than in completion order.
  const items = [30, 10, 20, 0];
  const result = await mapWithConcurrency(items, 4, async (delay, i) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return i;
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
});

test("mapWithConcurrency never runs more than `concurrency` tasks at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);

  await mapWithConcurrency(items, 3, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return item;
  });

  assert.ok(maxInFlight <= 3, `max concurrent tasks was ${maxInFlight}, expected <= 3`);
});

test("mapWithConcurrency runs every item exactly once and maps values correctly", async () => {
  const items = [1, 2, 3, 4, 5];
  const result = await mapWithConcurrency(items, 2, async (n) => n * 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test("mapWithConcurrency propagates a rejection from any task", async () => {
  const items = [1, 2, 3];
  await assert.rejects(
    () =>
      mapWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    /boom/,
  );
});

test("mapWithConcurrency handles an empty input array", async () => {
  const result = await mapWithConcurrency([], 4, async (n: number) => n);
  assert.deepEqual(result, []);
});

test("mapWithConcurrency works when concurrency exceeds the number of items", async () => {
  const items = [1, 2, 3];
  const result = await mapWithConcurrency(items, 100, async (n) => n + 1);
  assert.deepEqual(result, [2, 3, 4]);
});
