import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrend, epochStartOf, isEpochInProgress, EPOCH_SECONDS } from "../src/trend.js";

test("epoch boundaries land on Thursday 00:00 UTC", () => {
  // 2026-08-17T07:15:08Z (a Monday) sits inside the epoch that opened 2026-08-13.
  const start = epochStartOf(1_786_950_908);
  assert.equal(new Date(start * 1000).toISOString(), "2026-08-13T00:00:00.000Z");
  assert.equal(new Date(start * 1000).getUTCDay(), 4); // 4 = Thursday
});

test("epochStartOf is idempotent on a boundary", () => {
  const boundary = 1_786_579_200;
  assert.equal(epochStartOf(boundary), boundary);
});

test("the newest epoch counts as in progress until the week rolls over", () => {
  const epochStart = 1_786_579_200; // 2026-08-13T00:00:00Z
  const midWeek = epochStart + 4 * 86_400;

  assert.equal(isEpochInProgress(epochStart, midWeek), true);
  // Same pool data seen a week later: that epoch has closed, a newer one is live.
  assert.equal(isEpochInProgress(epochStart, epochStart + EPOCH_SECONDS), false);
});

test("momentum compares the recent half against the older half", () => {
  // Most recent first: recent half averages 400, older half averages 100.
  const { momentum, completedEpochs } = computeTrend([400, 400, 100, 100], false);
  assert.equal(completedEpochs, 4);
  assert.equal(momentum, 3);
});

test("a decaying pool reports negative momentum", () => {
  const { momentum } = computeTrend([50, 50, 200, 200], false);
  assert.equal(momentum, -0.75);
});

test("a flat pool reports no movement", () => {
  const { momentum } = computeTrend([120, 120, 120, 120, 120, 120], false);
  assert.equal(momentum, 0);
});

test("the in-progress epoch is excluded so a part-week cannot fake a decline", () => {
  // A steady $200/epoch pool, scanned three days into the current epoch: the
  // newest entry has only accrued $60 so far. Counting it would report a crash.
  const series = [60, 200, 200, 200, 200];

  assert.equal(computeTrend(series, true).momentum, 0);
  assert.ok((computeTrend(series, false).momentum as number) < -0.3);
});

test("the in-progress epoch also does not count toward the minimum history", () => {
  // Four entries, but one is the part-week: only three completed epochs remain.
  const { momentum, completedEpochs } = computeTrend([60, 200, 200, 200], true);
  assert.equal(completedEpochs, 3);
  assert.equal(momentum, null);
});

test("too little history reports null rather than a guess", () => {
  assert.equal(computeTrend([100, 100, 100], false).momentum, null);
  assert.equal(computeTrend([], false).momentum, null);
});

test("an odd history drops the middle epoch so both halves weigh the same", () => {
  // Recent half [400, 400], middle 999 ignored, older half [100, 100].
  assert.equal(computeTrend([400, 400, 999, 100, 100], false).momentum, 3);
});

test("a zero-paying older half reports null instead of infinite growth", () => {
  const { momentum, completedEpochs } = computeTrend([500, 500, 0, 0], false);
  assert.equal(momentum, null);
  assert.equal(completedEpochs, 4); // history was long enough; the baseline was not usable
});

test("a baseline of loose change reports null rather than a headline percentage", () => {
  // Taken from real snapshot data: $0.02/epoch rising to $5.75 computes to
  // +29,286%, which would outrank every genuine mover on the board.
  assert.equal(computeTrend([5.75, 5.75, 0.02, 0.02], false).momentum, null);
});

test("a real move over a real baseline is still reported", () => {
  // Also from live data: $53.88/epoch to $416.53 is the move the floor must not eat.
  const { momentum } = computeTrend([416.53, 416.53, 53.88, 53.88], false);
  assert.ok(momentum !== null && momentum > 6 && momentum < 8);
});

test("only the older half is floored, so a collapse to near-nothing still reports", () => {
  // $200/epoch decaying to $3: the recent half is tiny, which is the finding.
  const { momentum } = computeTrend([3, 3, 200, 200], false);
  assert.ok(momentum !== null && momentum < -0.95);
});

test("the baseline floor is overridable for callers with a different threshold", () => {
  assert.equal(computeTrend([5.75, 5.75, 0.02, 0.02], false, 0.01).momentum, 286.5);
});
