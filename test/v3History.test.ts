import { test } from "node:test";
import assert from "node:assert/strict";
import { appendV3Sample, isSteady, per10kNow, poolKey, steadiness, steadyPick, topPick, V3_STEADY_MIN_SAMPLES, windowStart } from "../src/v3History.js";
import type { V3ScanGauge } from "../src/v3.js";

const gauge = (gauge: string, weight: number, fees24h: number, incentives = 0): V3ScanGauge =>
  ({
    chain: "base",
    gauge: gauge as `0x${string}`,
    pool: "0x0" as `0x${string}`,
    weight,
    fees24hUsdPerDay: fees24h,
    feesUsdPerDay: fees24h,
    incentivesUsdPerDay: incentives,
    usdPerDayPer10k: null,
  }) as V3ScanGauge;

test("per10kNow: 24 h fees plus incentives, diluted by the 10,000 sAERO itself", () => {
  assert.equal(per10kNow(gauge("0xA", 90_000, 80, 20)), 10);
});

test("topPick: null when no pool meets the weight floor", () => {
  assert.equal(topPick([gauge("0xA", 50_000, 1000)]), null);
});

test("topPick: the highest per10k among eligible pools, ignoring one under the weight floor", () => {
  // 0xA pays the most in absolute terms but is under the 100,000 sAERO floor;
  // 0xC's smaller absolute pay is worth more per 10,000 sAERO once diluted.
  const picked = topPick([gauge("0xA", 50_000, 1000), gauge("0xB", 490_000, 10), gauge("0xC", 100_000, 100)]);
  assert.deepEqual(picked, { pool: "base:0xc", per10k: 9.0909 });
});

test("steadyPick: null when no pool has a steady week yet", () => {
  assert.equal(steadyPick([gauge("0xA", 490_000, 100)], {}, 0), null);
});

test("steadyPick: among several steady pools, the one whose weakest hour paid most — not the one paying most right now", () => {
  const n = V3_STEADY_MIN_SAMPLES;
  const pools = {
    "base:0xx": Array(n).fill(5), // steady at 5 all week: weakest hour paid 5.
    "base:0xy": Array(n).fill(2), // steady at 2 all week: weakest hour paid only 2.
  };
  // Right now 0xY pays far more (fees 500) than 0xX (fees 150), but steadyPick
  // judges by the week's weakest hour, not today's rate.
  const picked = steadyPick([gauge("0xX", 490_000, 150), gauge("0xY", 490_000, 500)], pools, 0);
  assert.deepEqual(picked, { pool: "base:0xx", per10k: 3, steady: true });
});

test("appendV3Sample: one column per pool, small pools left out, missing scans are null", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 24, h));
  let f = appendV3Sample(null, [gauge("0xA", 90_000, 100), gauge("0xB", 200_000, 210)], t(0));
  assert.deepEqual(Object.keys(f.pools), [poolKey(gauge("0xB", 0, 0))]);
  f = appendV3Sample(f, [gauge("0xC", 490_000, 50)], t(1));
  assert.deepEqual(f.at, [t(0).toISOString(), t(1).toISOString()]);
  assert.deepEqual(f.pools["base:0xb"], [10, null]);
  assert.deepEqual(f.pools["base:0xc"], [null, 1]);
});

test("appendV3Sample: samples past the keep window are dropped, and pools left with none", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 24, h));
  let f = appendV3Sample(null, [gauge("0xB", 200_000, 210)], t(0), 2);
  f = appendV3Sample(f, [gauge("0xC", 490_000, 50)], t(1), 2);
  f = appendV3Sample(f, [gauge("0xC", 490_000, 50)], t(3), 2);
  assert.deepEqual(f.at, [t(1).toISOString(), t(3).toISOString()]);
  assert.equal(f.pools["base:0xb"], undefined);
  assert.deepEqual(f.pools["base:0xc"], [1, 1]);
});

test("windowStart: the first sample inside the last week; none when all are older", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
  const f = { at: [t(0), t(100), t(200), t(300)].map((d) => d.toISOString()) };
  assert.equal(windowStart(f, t(300)), 2);
  assert.equal(windowStart(f, t(1000)), 4);
});

test("steadiness: needs a day of samples; steady when 75% pay half the average or more", () => {
  assert.equal(steadiness(Array(V3_STEADY_MIN_SAMPLES - 1).fill(3)), undefined);
  const even = steadiness([...Array(V3_STEADY_MIN_SAMPLES).fill(3), null]);
  assert.deepEqual(even, { held: 24, of: 24, avgPer10k: 3, minPer10k: 3 });
  assert.ok(isSteady(even));
  // One huge hour lifts the average so the rest fall below half of it.
  const spiky = steadiness([...Array(23).fill(1), 100]);
  assert.equal(spiky!.held, 1);
  assert.ok(!isSteady(spiky));
});

test("appendV3Sample: records the radar's pick for 10,000 sAERO, null for samples from before it was kept", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 24, h));
  const old = { at: [t(0).toISOString()], pools: { "base:0xb": [10] } };
  // 0xA pays more but is under 100,000 sAERO; 0xC pays 50 a day on 490,000: 1 for 10,000.
  const f = appendV3Sample(old, [gauge("0xA", 90_000, 900), gauge("0xB", 200_000, 10), gauge("0xC", 490_000, 50)], t(1));
  assert.deepEqual(f.picks, [null, { pool: "base:0xc", per10k: 1 }]);
  const g = appendV3Sample(f, [], t(2), 1);
  assert.deepEqual(g.picks, [{ pool: "base:0xc", per10k: 1 }, null]);
});

test("appendV3Sample: a week of steady samples makes the pick the steady pool whose weakest hour paid most", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 10, 1, h));
  const n = V3_STEADY_MIN_SAMPLES;
  // 0xB spikes once (hot, not steady); 0xC pays 2 every hour; 0xD pays 3 but dips to 1.6.
  const f = {
    at: Array.from({ length: n }, (_, i) => t(i).toISOString()),
    pools: {
      "base:0xb": [...Array(n - 1).fill(0.5), 90],
      "base:0xc": Array(n).fill(2),
      "base:0xd": [...Array(n - 1).fill(3), 1.6],
    },
  };
  const g = appendV3Sample(f, [gauge("0xB", 490_000, 500), gauge("0xC", 490_000, 100), gauge("0xD", 490_000, 150)], t(n));
  assert.deepEqual(g.picks!.at(-1), { pool: "base:0xc", per10k: 2, steady: true });
});
