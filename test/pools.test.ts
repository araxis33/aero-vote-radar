import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAlivePools, resolvePoolInfo } from "../src/pools.js";

test("filterAlivePools drops pools (and their paired gauge) whose gauge is not alive", () => {
  const result = filterAlivePools(
    ["0xpoolA", "0xpoolB", "0xpoolC"],
    ["0xgaugeA", "0xgaugeB", "0xgaugeC"],
    [true, false, true],
  );
  assert.deepEqual(result, {
    alivePools: ["0xpoolA", "0xpoolC"],
    aliveGauges: ["0xgaugeA", "0xgaugeC"],
  });
});

test("filterAlivePools returns empty arrays when no gauge is alive", () => {
  const result = filterAlivePools(["0xpoolA"], ["0xgaugeA"], [false]);
  assert.deepEqual(result, { alivePools: [], aliveGauges: [] });
});

test("resolvePoolInfo resolves a pool whose symbol/token0/token1 calls all succeed", () => {
  const { pools, skipped } = resolvePoolInfo(
    ["0xpoolA"],
    ["0xgaugeA"],
    [{ status: "success", result: "vAMM-A/B" }],
    [{ status: "success", result: "0xtokenA" }],
    [{ status: "success", result: "0xtokenB" }],
  );
  assert.equal(skipped, 0);
  assert.deepEqual(pools, [
    { address: "0xpoolA", symbol: "vAMM-A/B", token0: "0xtokenA", token1: "0xtokenB", gauge: "0xgaugeA", gaugeAlive: true },
  ]);
});

test("resolvePoolInfo skips a pool whose symbol call failed, without dropping the ones after it", () => {
  const { pools, skipped } = resolvePoolInfo(
    ["0xpoolA", "0xpoolB"],
    ["0xgaugeA", "0xgaugeB"],
    [{ status: "failure" }, { status: "success", result: "vAMM-B/C" }],
    [{ status: "success", result: "0xtokenA" }, { status: "success", result: "0xtokenB" }],
    [{ status: "success", result: "0xtokenA2" }, { status: "success", result: "0xtokenC" }],
  );
  assert.equal(skipped, 1);
  assert.deepEqual(pools, [
    { address: "0xpoolB", symbol: "vAMM-B/C", token0: "0xtokenB", token1: "0xtokenC", gauge: "0xgaugeB", gaugeAlive: true },
  ]);
});

test("resolvePoolInfo skips a pool if either token0 or token1 (not just symbol) fails", () => {
  const { pools: skippedOnToken0, skipped: skipped0 } = resolvePoolInfo(
    ["0xpoolA"],
    ["0xgaugeA"],
    [{ status: "success", result: "vAMM-A/B" }],
    [{ status: "failure" }],
    [{ status: "success", result: "0xtokenB" }],
  );
  assert.equal(skipped0, 1);
  assert.deepEqual(skippedOnToken0, []);

  const { pools: skippedOnToken1, skipped: skipped1 } = resolvePoolInfo(
    ["0xpoolA"],
    ["0xgaugeA"],
    [{ status: "success", result: "vAMM-A/B" }],
    [{ status: "success", result: "0xtokenA" }],
    [{ status: "failure" }],
  );
  assert.equal(skipped1, 1);
  assert.deepEqual(skippedOnToken1, []);
});

test("resolvePoolInfo pairs each resolved pool with its gauge by matching index, not original position", () => {
  const { pools } = resolvePoolInfo(
    ["0xpoolA", "0xpoolB"],
    ["0xgaugeA", "0xgaugeB"],
    [{ status: "success", result: "sym-A" }, { status: "success", result: "sym-B" }],
    [{ status: "success", result: "0xt0A" }, { status: "success", result: "0xt0B" }],
    [{ status: "success", result: "0xt1A" }, { status: "success", result: "0xt1B" }],
  );
  assert.equal(pools[0].gauge, "0xgaugeA");
  assert.equal(pools[1].gauge, "0xgaugeB");
});
