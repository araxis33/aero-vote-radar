#!/usr/bin/env node
import { rankPoolsByEfficiency } from "./efficiency.js";
import { recommendAllocation } from "./allocator.js";
import { fetchVeAeroPositions } from "./veAero.js";
import { isValidAddress } from "./util.js";

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// Per-vote values are often fractions of a cent (a pool's weekly incentives
// split across millions of votes) — fmtUsd alone would just print "$0" for those.
function fmtUsdPerVote(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return fmtUsd(n);
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * Parses a `--name` flag as a positive integer, falling back to `fallback` if
 * the flag is absent. Returns undefined (rather than NaN or a silently-clamped
 * value) if the flag was given but isn't a positive integer, so callers can
 * print a clear usage error instead of e.g. `Array.slice` quietly treating a
 * garbled `--top abc` as 0 or a negative `--top` as "drop the last N rows".
 *
 * A dangling flag with no value (e.g. `--top` as the last argument) must hit
 * this same error path rather than the fallback: `getFlag` returns undefined
 * for both "flag absent" and "flag present but out of args", so `hasFlag` is
 * checked separately to tell the two apart.
 */
export function parsePositiveIntFlag(args: string[], name: string, fallback: number): number | undefined {
  const raw = getFlag(args, name);
  if (raw === undefined) return hasFlag(args, name) ? undefined : fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function cmdPools(args: string[]) {
  const top = parsePositiveIntFlag(args, "top", 20);
  if (top === undefined) {
    console.error("Usage: aero-vote-radar pools [--top N] (N must be a positive integer)");
    process.exitCode = 1;
    return;
  }
  const ranked = await rankPoolsByEfficiency();

  console.log(`\nTop ${top} Aerodrome pools by predicted $/veAERO vote (of ${ranked.length} live-gauge pools with votes):\n`);
  console.log(
    ["Symbol", "Votes(veAERO)", "Latest $/vote", "Predicted $/vote", "Edge"]
      .map((h) => h.padEnd(18))
      .join(""),
  );
  for (const p of ranked.slice(0, top)) {
    console.log(
      [
        p.pool.symbol.padEnd(18),
        p.currentVotesVeAero.toLocaleString("en-US", { maximumFractionDigits: 0 }).padEnd(18),
        fmtUsdPerVote(p.currentValuePerVote).padEnd(18),
        fmtUsdPerVote(p.predictedValuePerVote).padEnd(18),
        `${(p.predictiveEdge * 100).toFixed(1)}%`,
      ].join(""),
    );
  }
}

async function cmdRecommend(args: string[]) {
  const veaero = Number(getFlag(args, "veaero"));
  const topK = parsePositiveIntFlag(args, "top", 15);

  if (!Number.isFinite(veaero) || veaero <= 0 || topK === undefined) {
    console.error("Usage: aero-vote-radar recommend --veaero <amount> [--top K] (amount must be a finite positive number, K must be a positive integer)");
    process.exitCode = 1;
    return;
  }

  const ranked = await rankPoolsByEfficiency();
  const allocation = recommendAllocation(ranked, veaero, topK);
  const totalExpectedUsd = allocation.reduce((a, b) => a + b.expectedUsd, 0);

  console.log(`\nRecommended allocation for ${veaero.toLocaleString("en-US")} veAERO (top ${topK} candidates considered):\n`);
  console.log(["Symbol", "Weight", "veAERO", "Expected $/epoch"].map((h) => h.padEnd(18)).join(""));
  for (const a of allocation) {
    console.log(
      [
        a.symbol.padEnd(18),
        `${(a.weight * 100).toFixed(1)}%`.padEnd(18),
        a.veAeroAllocated.toLocaleString("en-US", { maximumFractionDigits: 0 }).padEnd(18),
        fmtUsd(a.expectedUsd),
      ].join(""),
    );
  }
  console.log(`\nTotal expected value next epoch (heuristic, trailing-average based): ${fmtUsd(totalExpectedUsd)}`);
  console.log("You vote this yourself on aerodrome.finance — this tool never touches your wallet or keys.\n");
}

async function cmdMyVeAero(args: string[]) {
  const address = args[0];
  if (!address || !isValidAddress(address)) {
    console.error("Usage: aero-vote-radar my-veaero <wallet address> (must be a 0x-prefixed 40-character hex address)");
    process.exitCode = 1;
    return;
  }
  const positions = await fetchVeAeroPositions(address);
  if (positions.length === 0) {
    console.log(`No veAERO locks found for ${address}.`);
    return;
  }
  console.log(`\nveAERO locks for ${address}:\n`);
  for (const p of positions) {
    // expiresAt is 0 for permanently-locked veNFTs (no expiry), not literally Jan 1 1970.
    const expires = p.expiresAt === 0 ? "never (permanent lock)" : new Date(p.expiresAt * 1000).toISOString().slice(0, 10);
    console.log(`  NFT #${p.id}: ${p.votingPowerVeAero.toLocaleString("en-US")} veAERO voting power, expires ${expires}`);
  }
  const total = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);
  console.log(`\nTotal voting power: ${total.toLocaleString("en-US")} veAERO\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "pools":
      return cmdPools(rest);
    case "recommend":
      return cmdRecommend(rest);
    case "my-veaero":
      return cmdMyVeAero(rest);
    default:
      console.log(`aero-vote-radar — Aerodrome (Base) veAERO vote-efficiency tool

Commands:
  pools [--top N]                Rank live-gauge pools by current & predicted $/vote
  recommend --veaero N [--top K] Recommend a self-dilution-aware allocation for N veAERO
  my-veaero <address>            Look up an account's veAERO locks and voting power
`);
      return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
