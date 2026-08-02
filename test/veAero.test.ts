import { test } from "node:test";
import assert from "node:assert/strict";
import { toVeNftSummary } from "../src/veAero.js";

test("toVeNftSummary converts voting_amount from 18-decimal wei into veAERO", () => {
  const summary = toVeNftSummary({ id: 6n, voting_amount: 11_362_738_622_000_000_000_000_000n, expires_at: 0n });
  assert.equal(summary.votingPowerVeAero, 11_362_738.622);
});

test("toVeNftSummary keeps expiresAt 0 for a permanently-locked veNFT rather than treating it as Jan 1 1970", () => {
  const summary = toVeNftSummary({ id: 6n, voting_amount: 0n, expires_at: 0n });
  assert.equal(summary.expiresAt, 0);
});

test("toVeNftSummary passes through a non-zero expires_at as a unix-seconds number", () => {
  const summary = toVeNftSummary({ id: 1n, voting_amount: 0n, expires_at: 1_893_456_000n });
  assert.equal(summary.expiresAt, 1_893_456_000);
});

test("toVeNftSummary stringifies the NFT id without precision loss for ids beyond Number.MAX_SAFE_INTEGER", () => {
  const bigId = 2n ** 60n + 3n; // far beyond 2^53, would lose precision as a plain Number
  const summary = toVeNftSummary({ id: bigId, voting_amount: 0n, expires_at: 0n });
  assert.equal(summary.id, bigId.toString());
});

test("toVeNftSummary returns 0 voting power for an NFT with no locked amount", () => {
  const summary = toVeNftSummary({ id: 17324n, voting_amount: 0n, expires_at: 0n });
  assert.equal(summary.votingPowerVeAero, 0);
});
