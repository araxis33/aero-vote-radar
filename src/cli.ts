#!/usr/bin/env node
import { rankPoolsByEfficiency, type PoolEfficiency } from "./efficiency.js";
import { recommendAllocation, toWholePercentWeights } from "./allocator.js";
import { backtestLive } from "./backtest.js";
import { fetchVeAeroPositions, type VeNftSummary } from "./veAero.js";
import { BACKTEST_EPOCHS } from "./constants.js";
import { formatError, isValidAddress } from "./util.js";

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
 * Shapes a ranked pool for --json output. Kept in parity with the MCP
 * `list_pool_efficiency` tool's response shape, including `epochsObserved` —
 * without it, a --json consumer can't tell a prediction backed by 6 trailing
 * epochs from one backed by a single epoch of a brand-new pool.
 */
export function poolEfficiencyToJson(p: PoolEfficiency) {
  return {
    symbol: p.pool.symbol,
    pool: p.pool.address,
    votesVeAero: p.currentVotesVeAero,
    currentValuePerVote: p.currentValuePerVote,
    predictedValuePerVote: p.predictedValuePerVote,
    predictiveEdge: p.predictiveEdge,
    epochsObserved: p.epochsObserved,
    volatility: p.volatility,
    consistency: p.consistency,
  };
}

/**
 * Shapes an account's veAERO positions for --json output, matching the MCP
 * `get_my_veaero` tool's response shape (`{ address, totalVeAero, locks }`).
 */
export function veAeroPositionsToJson(address: string, positions: VeNftSummary[]) {
  const totalVeAero = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);
  return { address, totalVeAero, locks: positions };
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

/**
 * Parses a `--name` flag as a 0..1 fraction (used by `--min-consistency`),
 * following the same "undefined means the caller should print usage" contract
 * as `parsePositiveIntFlag`. 0 and 1 are both accepted: 0 is a meaningful
 * "don't filter at all" and 1 means "only perfectly steady pools".
 */
export function parseUnitIntervalFlag(args: string[], name: string, fallback: number): number | undefined {
  const raw = getFlag(args, name);
  if (raw === undefined) return hasFlag(args, name) ? undefined : fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

async function cmdPools(args: string[]) {
  const top = parsePositiveIntFlag(args, "top", 20);
  const minConsistency = parseUnitIntervalFlag(args, "min-consistency", 0);
  if (top === undefined || minConsistency === undefined) {
    console.error("Usage: aero-vote-radar pools [--top N] [--min-consistency 0..1] [--json] (N must be a positive integer, min-consistency a number from 0 to 1)");
    process.exitCode = 1;
    return;
  }
  const ranked = await rankPoolsByEfficiency();
  const eligible = ranked.filter((p) => p.consistency >= minConsistency);
  const topRanked = eligible.slice(0, top);

  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(topRanked.map(poolEfficiencyToJson), null, 2));
    return;
  }

  const filterNote =
    minConsistency > 0 ? ` (${eligible.length} of ${ranked.length} pass consistency >= ${minConsistency})` : "";
  console.log(`\nTop ${top} Aerodrome pools by predicted $/veAERO vote (of ${ranked.length} live-gauge pools with votes)${filterNote}:\n`);
  console.log(
    ["Symbol", "Votes(veAERO)", "Latest $/vote", "Predicted $/vote", "Edge", "Consistency"]
      .map((h) => h.padEnd(18))
      .join(""),
  );
  for (const p of topRanked) {
    console.log(
      [
        p.pool.symbol.padEnd(18),
        p.currentVotesVeAero.toLocaleString("en-US", { maximumFractionDigits: 0 }).padEnd(18),
        fmtUsdPerVote(p.currentValuePerVote).padEnd(18),
        fmtUsdPerVote(p.predictedValuePerVote).padEnd(18),
        `${(p.predictiveEdge * 100).toFixed(1)}%`.padEnd(18),
        p.consistency.toFixed(2),
      ].join(""),
    );
  }
  console.log("\nConsistency: 1.00 = identical payout every epoch, lower = spikier. A high predicted $/vote");
  console.log("backed by low consistency is usually one big one-off bribe, not a repeatable opportunity.\n");
}

const RECOMMEND_USAGE =
  "Usage: aero-vote-radar recommend (--veaero <amount> | --address <0x...>) [--top K] [--min-consistency 0..1] [--vote-ready] [--json]";

/**
 * Resolves the veAERO budget from either an explicit `--veaero` amount or, with
 * `--address`, the wallet's actual on-chain voting power — so the common case
 * stops being "go look up your own balance first, then retype it here".
 * Returns null after printing its own error, so the caller just bails.
 */
async function resolveBudget(args: string[]): Promise<number | null> {
  const rawVeaero = getFlag(args, "veaero");
  const address = getFlag(args, "address");

  if (rawVeaero !== undefined && address !== undefined) {
    console.error(`${RECOMMEND_USAGE}\nPass either --veaero or --address, not both.`);
    return null;
  }

  if (address !== undefined) {
    if (!isValidAddress(address)) {
      console.error(`${RECOMMEND_USAGE}\n--address must be a 0x-prefixed 40-character hex address.`);
      return null;
    }
    const positions = await fetchVeAeroPositions(address);
    const total = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);
    if (total <= 0) {
      console.error(`No veAERO voting power found for ${address} — nothing to allocate.`);
      return null;
    }
    console.log(`\nUsing ${total.toLocaleString("en-US", { maximumFractionDigits: 3 })} veAERO of live voting power from ${address} (${positions.length} lock(s)).`);
    return total;
  }

  const veaero = Number(rawVeaero);
  if (rawVeaero === undefined || !Number.isFinite(veaero) || veaero <= 0) {
    console.error(`${RECOMMEND_USAGE}\nAmount must be a finite positive number.`);
    return null;
  }
  return veaero;
}

async function cmdRecommend(args: string[]) {
  const topK = parsePositiveIntFlag(args, "top", 15);
  const minConsistency = parseUnitIntervalFlag(args, "min-consistency", 0);
  if (topK === undefined || minConsistency === undefined) {
    console.error(`${RECOMMEND_USAGE}\nK must be a positive integer, min-consistency a number from 0 to 1.`);
    process.exitCode = 1;
    return;
  }

  const veaero = await resolveBudget(args);
  if (veaero === null) {
    process.exitCode = 1;
    return;
  }

  const ranked = (await rankPoolsByEfficiency()).filter((p) => p.consistency >= minConsistency);
  const allocation = recommendAllocation(ranked, veaero, topK);
  const totalExpectedUsd = allocation.reduce((a, b) => a + b.expectedUsd, 0);
  const votePercents = toWholePercentWeights(allocation);

  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ veAeroBudget: veaero, allocation, votePercents, totalExpectedUsd }, null, 2));
    return;
  }

  if (hasFlag(args, "vote-ready")) {
    console.log(`\nVote-ready weights for ${veaero.toLocaleString("en-US", { maximumFractionDigits: 0 })} veAERO — whole percentages, summing to exactly 100:\n`);
    for (const v of votePercents) {
      console.log(`  ${v.percent.toString().padStart(3)}%  ${v.symbol}`);
    }
    console.log(`\nEnter these directly on aerodrome.finance. Expected next epoch: ${fmtUsd(totalExpectedUsd)}.`);
    console.log("This tool never touches your wallet or keys.\n");
    return;
  }

  console.log(`\nRecommended allocation for ${veaero.toLocaleString("en-US", { maximumFractionDigits: 0 })} veAERO (top ${topK} candidates considered):\n`);
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
  console.log("Pass --vote-ready for whole percentages you can type straight into Aerodrome's voting UI.");
  console.log("You vote this yourself on aerodrome.finance — this tool never touches your wallet or keys.\n");
}

async function cmdBacktest(args: string[]) {
  const epochs = parsePositiveIntFlag(args, "epochs", BACKTEST_EPOCHS);
  if (epochs === undefined) {
    console.error("Usage: aero-vote-radar backtest (--veaero <amount> | --address <0x...>) [--epochs N] [--json] (N must be a positive integer)");
    process.exitCode = 1;
    return;
  }

  const veaero = await resolveBudget(args);
  if (veaero === null) {
    process.exitCode = 1;
    return;
  }

  const report = await backtestLive(veaero, epochs);

  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.epochsTested === 0) {
    console.log("\nNot enough epoch history to backtest — no epoch had a qualifying candidate pool.\n");
    return;
  }

  console.log(`\nBacktest over the last ${report.epochsTested} epoch(s) with ${veaero.toLocaleString("en-US", { maximumFractionDigits: 0 })} veAERO:\n`);
  console.log(["EpochsAgo", "Radar $", "Naive $", "Naive picked"].map((h) => h.padEnd(18)).join(""));
  for (const e of report.epochs) {
    console.log(
      [
        String(e.epochsAgo).padEnd(18),
        fmtUsd(e.radarUsd).padEnd(18),
        fmtUsd(e.naiveUsd).padEnd(18),
        e.naiveSymbol ?? "-",
      ].join(""),
    );
  }

  const uplift = report.upliftPct === null ? "n/a (baseline earned $0)" : `${(report.upliftPct * 100).toFixed(1)}%`;
  console.log(`\nTotal: radar ${fmtUsd(report.radarTotalUsd)} vs naive ${fmtUsd(report.naiveTotalUsd)} — uplift ${uplift}`);
  console.log(`Radar earned more in ${report.epochsWonByRadar} of ${report.epochsTested} epoch(s).`);
  console.log("\nEpochsAgo 0 is the most recently completed epoch. 'Naive' = put everything in the pool with the");
  console.log("highest $/vote at the time. Decisions use only data available before each epoch resolved, but this");
  console.log("assumes your votes wouldn't have moved anyone else's, and only sees pools whose gauge is still alive.\n");
}

async function cmdMyVeAero(args: string[]) {
  // Find the first non-flag argument rather than assuming args[0], so
  // `--json` can be passed either before or after the address.
  const address = args.find((a) => !a.startsWith("--"));
  if (!address || !isValidAddress(address)) {
    console.error("Usage: aero-vote-radar my-veaero <wallet address> [--json] (must be a 0x-prefixed 40-character hex address)");
    process.exitCode = 1;
    return;
  }
  const positions = await fetchVeAeroPositions(address);

  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(veAeroPositionsToJson(address, positions), null, 2));
    return;
  }

  if (positions.length === 0) {
    console.log(`No veAERO locks found for ${address}.`);
    return;
  }
  console.log(`\nveAERO locks for ${address}:\n`);
  for (const p of positions) {
    // expiresAt is 0 both for a permanent lock and for a lock with nothing left
    // in it, so read isPermanent rather than treating 0 as Jan 1 1970 or as
    // proof of permanence.
    const expires = p.isPermanent
      ? "never (permanent lock)"
      : p.expiresAt === 0
        ? "no active lock"
        : new Date(p.expiresAt * 1000).toISOString().slice(0, 10);
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
    case "backtest":
      return cmdBacktest(rest);
    case "my-veaero":
      return cmdMyVeAero(rest);
    default:
      console.log(`aero-vote-radar — Aerodrome (Base) veAERO vote-efficiency tool

Commands:
  pools [--top N] [--min-consistency 0..1] [--json]
      Rank live-gauge pools by current & predicted $/vote, with a consistency score

  recommend (--veaero N | --address 0x...) [--top K] [--min-consistency 0..1] [--vote-ready] [--json]
      Recommend a self-dilution-aware allocation. --address reads your live voting
      power on-chain instead of you typing the amount; --vote-ready prints whole
      percentages that sum to 100, ready for Aerodrome's voting UI.

  backtest (--veaero N | --address 0x...) [--epochs N] [--json]
      Replay past epochs and compare this tool's allocation against the naive
      "vote for the highest current $/vote" strategy.

  my-veaero <address> [--json]
      Look up an account's veAERO locks and voting power

Pass --json to any command for machine-readable output instead of a table.
`);
      return;
  }
}

main().catch((err) => {
  console.error(`Error: ${formatError(err)}`);
  process.exitCode = 1;
});
