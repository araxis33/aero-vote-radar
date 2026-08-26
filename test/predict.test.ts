import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asRatio,
  inBucket,
  scorePredictors,
  SIZE_BUCKETS,
  type PredictionObservation,
} from "../src/predict.js";

const obs = (actual: number, predicted: Record<string, number>, tally = actual): PredictionObservation => ({
  actual,
  predicted,
  tally,
});

const byName = (scores: ReturnType<typeof scorePredictors>, name: string) =>
  scores.find((s) => s.name === name)!;

test("a predictor that is always right scores zero error and zero bias", () => {
  const scores = scorePredictors(
    [obs(1_000, { exact: 1_000 }), obs(50_000, { exact: 50_000 })],
    ["exact"],
  );
  assert.equal(byName(scores, "exact").medianAbsError, 0);
  assert.equal(byName(scores, "exact").medianBias, 0);
  assert.equal(byName(scores, "exact").observations, 2);
});

test("error is measured on a log scale, so the same ratio scores the same at any size", () => {
  // Both guesses are 2x too high. In votes those misses are 1,000 and 1,000,000
  // apart; as a ratio they are identical, and a ratio is what the payout cares
  // about — value * yours / (weight + yours).
  const scores = scorePredictors(
    [obs(1_000, { double: 2_000 }), obs(1_000_000, { double: 2_000_000 })],
    ["double"],
  );
  assert.ok(Math.abs(asRatio(byName(scores, "double").medianAbsError) - 1) < 1e-9);
});

test("bias separates a noisy predictor from a systematically high one", () => {
  // Both are 50% out on every observation. `noisy` misses in both directions and
  // is unbiased; `high` only ever guesses above. Absolute error cannot tell them
  // apart, and the difference is exactly what made the retired basis harmful.
  const observations = [
    obs(1_000, { noisy: 1_500, high: 1_500 }),
    obs(1_000, { noisy: 1_000 / 1.5, high: 1_500 }),
    obs(1_000, { noisy: 1_500, high: 1_500 }),
    obs(1_000, { noisy: 1_000 / 1.5, high: 1_500 }),
  ];
  const scores = scorePredictors(observations, ["noisy", "high"]);

  assert.ok(
    Math.abs(byName(scores, "noisy").medianAbsError - byName(scores, "high").medianAbsError) < 1e-9,
    "the two are equally inaccurate",
  );
  assert.ok(Math.abs(byName(scores, "noisy").medianBias) < 1e-9, "noisy is unbiased");
  assert.ok(asRatio(byName(scores, "high").medianBias) > 0.49, "high is biased upward");
});

test("closest-of counts go to the nearest predictor, once per observation", () => {
  const scores = scorePredictors(
    [
      obs(1_000, { near: 1_050, far: 4_000 }),
      obs(1_000, { near: 950, far: 100 }),
      obs(1_000, { near: 2_000, far: 1_010 }),
    ],
    ["near", "far"],
  );
  assert.equal(byName(scores, "near").closestOn, 2);
  assert.equal(byName(scores, "far").closestOn, 1);
});

test("a predictor with nothing to say is skipped, not scored as infinitely wrong", () => {
  // "this basis had no usable figure here" and "this basis was badly wrong here"
  // are different findings, and `observations` is what tells them apart.
  const scores = scorePredictors(
    [
      obs(1_000, { sometimes: 1_100, always: 1_100 }),
      obs(1_000, { sometimes: 0, always: 1_100 }),
      obs(1_000, { sometimes: Number.NaN, always: 1_100 }),
    ],
    ["sometimes", "always"],
  );
  assert.equal(byName(scores, "sometimes").observations, 1);
  assert.equal(byName(scores, "always").observations, 3);
});

test("closest-of only counts observations where every predictor produced a figure", () => {
  // Otherwise a basis that quietly declines the hard cases would collect wins on
  // the easy ones and look better than one that answered every time.
  const scores = scorePredictors(
    [
      obs(1_000, { picky: 1_010, complete: 1_500 }),
      obs(1_000, { picky: 0, complete: 1_500 }),
      obs(1_000, { picky: 0, complete: 1_500 }),
    ],
    ["picky", "complete"],
  );
  assert.equal(byName(scores, "picky").closestOn + byName(scores, "complete").closestOn, 1);
});

test("an observation with no settled weight is dropped entirely", () => {
  const scores = scorePredictors(
    [obs(0, { a: 500 }), obs(-5, { a: 500 }), obs(1_000, { a: 1_000 })],
    ["a"],
  );
  assert.equal(byName(scores, "a").observations, 1);
});

test("an empty input scores no observations rather than throwing", () => {
  const scores = scorePredictors([], ["a", "b"]);
  assert.equal(scores.length, 2);
  assert.equal(scores[0].observations, 0);
  assert.ok(Number.isNaN(scores[0].medianAbsError));
});

test("size buckets partition the range without gaps or overlap", () => {
  for (const tally of [0, 1, 9_999, 10_000, 99_999, 100_000, 999_999, 1_000_000, 5e9]) {
    const matched = SIZE_BUCKETS.filter((b) => inBucket(obs(1, { a: 1 }, tally), b));
    assert.equal(matched.length, 1, `tally ${tally} landed in ${matched.length} buckets`);
  }
});
