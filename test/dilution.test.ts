import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVoteStability,
  expectedDilutedVotes,
  MIN_VOTE_EPOCHS,
} from "../src/dilution.js";

test("the epoch still running is excluded from the typical weight, like it is from momentum", () => {
  // Entry 0 is a part-week whose weight is still being written. Folding it in
  // would drag "typical" toward whatever this week happens to look like so far.
  const withPartial = computeVoteStability([10, 4_000, 4_000, 4_000, 4_000], true, 10);
  assert.equal(withPartial.expectedVotes, 4_000);
  assert.equal(withPartial.completedEpochs, 4);

  const asFinished = computeVoteStability([10, 4_000, 4_000, 4_000, 4_000], false, 10);
  assert.equal(asFinished.completedEpochs, 5);
  assert.equal(asFinished.expectedVotes, 4_000); // median is robust; the mean would not be
});

test("a single parked epoch does not become the typical weight — this is why it is a median", () => {
  // The live shape this module was written for: six ordinary epochs and one
  // week where a block of veAERO was parked and then withdrawn.
  const votes = [280_000, 18_100_000, 774_000, 2_200_000, 4_600_000, 3_500_000, 3_900_000];
  const { expectedVotes } = computeVoteStability(votes, false, 280_000);

  const mean = votes.reduce((a, b) => a + b, 0) / votes.length;
  assert.equal(expectedVotes, 3_500_000);
  assert.ok(mean > 4_700_000, "the mean is dragged above every ordinary epoch by the one spike");
  assert.ok(expectedVotes! < mean, "the median stays inside the ordinary range");
});

test("refillRatio says how optimistic the current per-vote figure is", () => {
  // Sitting at 452k against a typical 11.6M: the advertised rate is ~25x too high.
  const { refillRatio } = computeVoteStability(
    [452_000, 11_600_000, 11_600_000, 11_600_000],
    true,
    452_000,
  );
  assert.ok(refillRatio !== null);
  assert.ok(Math.abs(refillRatio! - 11_600_000 / 452_000) < 1e-9);
});

test("a pool sitting above its usual weight reports a refillRatio below 1 rather than null", () => {
  const { refillRatio } = computeVoteStability([9_000, 3_000, 3_000, 3_000], true, 9_000);
  assert.ok(refillRatio !== null);
  assert.ok(refillRatio! < 1);
});

test("a vote weight below the floor reports no ratio, so dust cannot top the list", () => {
  // The failure this guard exists for: 1,364 votes against a history of
  // near-zero produced a 2,577x "refill" that described nothing.
  const dust = computeVoteStability([1_364, 0.5, 0.5, 0.5], true, 1_364);
  assert.equal(dust.refillRatio, null);
  assert.notEqual(dust.expectedVotes, null, "the raw figure is still reported, only the ratio is withheld");

  const currentTooSmall = computeVoteStability([5, 50_000, 50_000, 50_000], true, 5);
  assert.equal(currentTooSmall.refillRatio, null);
});

test("too little completed history reports nulls rather than a figure from one epoch", () => {
  const oneEpoch = computeVoteStability([500, 4_000], true, 500);
  assert.equal(oneEpoch.completedEpochs, 1);
  assert.ok(oneEpoch.completedEpochs < MIN_VOTE_EPOCHS);
  assert.equal(oneEpoch.expectedVotes, null);
  assert.equal(oneEpoch.refillRatio, null);
  assert.equal(oneEpoch.voteStability, 0);
});

test("a pool that never had votes reports nulls instead of dividing by zero", () => {
  const empty = computeVoteStability([0, 0, 0, 0], true, 0);
  assert.equal(empty.expectedVotes, null);
  assert.equal(empty.refillRatio, null);
  assert.equal(empty.voteVolatility, 0);
});

test("voteStability separates a steady denominator from one that jumps around", () => {
  const steady = computeVoteStability([100, 4_000, 4_000, 4_000, 4_000], true, 100);
  const jumpy = computeVoteStability([100, 400, 8_000, 400, 8_000], true, 100);

  assert.equal(steady.voteVolatility, 0);
  assert.equal(steady.voteStability, 1);
  assert.ok(jumpy.voteStability < steady.voteStability);
  assert.ok(jumpy.voteStability > 0);
});

test("the floor is overridable for callers working at a different scale", () => {
  const votes = [50, 200, 200, 200];
  assert.equal(computeVoteStability(votes, true, 50).refillRatio, null);

  const loosened = computeVoteStability(votes, true, 50, 10);
  assert.ok(loosened.refillRatio !== null);
  assert.ok(Math.abs(loosened.refillRatio! - 4) < 1e-9);
});

test("expectedDilutedVotes takes the larger side, so it cannot err in the voter's favour", () => {
  assert.equal(expectedDilutedVotes(452_000, 11_600_000), 11_600_000); // will be refilled
  assert.equal(expectedDilutedVotes(9_000, 3_000), 9_000); // already carrying more than usual
});

test("expectedDilutedVotes falls back to the current weight when there is no history", () => {
  // A brand-new pool is neither penalised nor handed a fictional baseline.
  assert.equal(expectedDilutedVotes(1_234, null), 1_234);
});
