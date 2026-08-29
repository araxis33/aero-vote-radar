#!/usr/bin/env node
import { rankPoolsByEfficiency, type PoolEfficiency } from "./efficiency.js";
import {
  recommendAllocation,
  toWholePercentWeights,
  expectedUsdForWholePercentVote,
  unallocatedVeAero,
  voteBasisCaveat,
  type VoteBasis,
} from "./allocator.js";
import { backtestLive } from "./backtest.js";
import { fetchVeAeroPositions, type VeNftSummary } from "./veAero.js";
import { BACKTEST_EPOCHS, MAX_BACKTEST_EPOCHS } from "./constants.js";
import { formatError, isValidAddress, wrapText } from "./util.js";
import { computeTrend, epochEndOf, formatDuration, isEpochInProgress } from "./trend.js";

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
 *
 * `momentum` is derived here rather than stored on `PoolEfficiency`, the same
 * way `snapshot.ts`'s `toSnapshotPool` derives it for the web app — it needs
 * to know whether the latest epoch is still in progress, which depends on
 * *when* the caller is asking, not on anything the ranking itself computed.
 * `asOfUnixSeconds` is a parameter (not read from the clock inside) so this
 * stays pure and testable.
 */
export function poolEfficiencyToJson(p: PoolEfficiency, asOfUnixSeconds: number) {
  const currentEpochPartial = isEpochInProgress(p.latestEpochTs, asOfUnixSeconds);
  const { momentum } = computeTrend(p.epochUsdSeries, currentEpochPartial);
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
    momentum,
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
 *
 * `max`, when given, rejects a value above it the same way — callers whose
 * flag drives an on-chain fetch (e.g. `--epochs`) can bound it so a mistyped
 * value can't balloon into a much larger live scan than intended.
 */
export function parsePositiveIntFlag(args: string[], name: string, fallback: number, max?: number): number | undefined {
  const raw = getFlag(args, name);
  if (raw === undefined) return hasFlag(args, name) ? undefined : fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return max !== undefined && n > max ? undefined : n;
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

/**
 * Parses `--vote-basis`, which decides whether a pool is judged against the
 * weight it carries right now or the weight it usually settles at. Follows the
 * same "undefined means print usage" contract as the flags above, so a typo
 * prints help rather than silently falling back to a different strategy than
 * the one asked for.
 */
export function parseVoteBasisFlag(args: string[], fallback: VoteBasis = "previous"): VoteBasis | undefined {
  const raw = getFlag(args, "vote-basis");
  if (raw === undefined) return hasFlag(args, "vote-basis") ? undefined : fallback;
  return raw === "previous" || raw === "current" || raw === "typical" ? raw : undefined;
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
    const asOfUnixSeconds = Math.floor(Date.now() / 1000);
    console.log(JSON.stringify(topRanked.map((p) => poolEfficiencyToJson(p, asOfUnixSeconds)), null, 2));
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
  "Usage: aero-vote-radar recommend (--veaero <amount> | --address <0x...>) [--top K] [--min-consistency 0..1] [--max-weight 0..1] [--vote-basis previous|current|typical] [--vote-ready] [--json]";

const BACKTEST_USAGE = `Usage: aero-vote-radar backtest (--veaero <amount> | --address <0x...>) [--epochs N] [--min-consistency 0..1] [--json] (N must be a positive integer, max ${MAX_BACKTEST_EPOCHS}; min-consistency a number from 0 to 1)`;

/**
 * Resolves the veAERO budget from either an explicit `--veaero` amount or, with
 * `--address`, the wallet's actual on-chain voting power — so the common case
 * stops being "go look up your own balance first, then retype it here". Shared
 * by `recommend` and `backtest`, which take a `usage` string each so a bad
 * `--veaero`/`--address` shows the calling command's own usage (flags, etc.)
 * rather than always printing `recommend`'s.
 * Returns null after printing its own error, so the caller just bails.
 */
export async function resolveBudget(args: string[], usage: string): Promise<number | null> {
  const rawVeaero = getFlag(args, "veaero");
  const address = getFlag(args, "address");

  if (rawVeaero !== undefined && address !== undefined) {
    console.error(`${usage}\nPass either --veaero or --address, not both.`);
    return null;
  }

  if (address !== undefined) {
    if (!isValidAddress(address)) {
      console.error(`${usage}\n--address must be a 0x-prefixed 40-character hex address.`);
      return null;
    }
    const positions = await fetchVeAeroPositions(address);
    const total = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);
    if (total <= 0) {
      console.error(`No veAERO voting power found for ${address} — nothing to allocate.`);
      return null;
    }
    // stderr, not stdout: this status line runs before cmdRecommend/cmdBacktest
    // get a chance to check --json, so putting it on stdout would prepend
    // human-readable text to what's supposed to be a clean JSON payload for
    // `recommend --address ... --json` / `backtest --address ... --json`.
    console.error(`\nUsing ${total.toLocaleString("en-US", { maximumFractionDigits: 3 })} veAERO of live voting power from ${address} (${positions.length} lock(s)).`);
    return total;
  }

  const veaero = Number(rawVeaero);
  if (rawVeaero === undefined || !Number.isFinite(veaero) || veaero <= 0) {
    console.error(`${usage}\nAmount must be a finite positive number.`);
    return null;
  }
  return veaero;
}

/**
 * One line saying how long this recommendation stays actionable.
 *
 * A vote only counts toward the epoch it is cast in, so a ranking is advice
 * with a deadline attached — and the deadline was previously stated nowhere.
 * Exported for testing, and takes its clock as an argument so the test can pin
 * one instead of racing the real one.
 */
export function epochDeadlineLine(now: Date = new Date()): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  const endsAt = epochEndOf(nowSec);
  const stamp = `${new Date(endsAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `Voting for this epoch closes in ${formatDuration(endsAt - nowSec)} (${stamp}) — a vote cast after that counts toward the next epoch.`;
}

/**
 * Prints the vote-basis caveat, if this budget has one, together with the
 * command that settles it for this particular voter rather than in general.
 *
 * The caveat itself is deliberately not a recommendation — see
 * `voteBasisCaveat` — so what is added here is the way to check, not a nudge:
 * `backtest` prints both bases side by side on the epochs available today, and
 * that is a number about the reader's own size rather than about the size the
 * constant was measured at.
 */
function printVoteBasisCaveat(veAeroBudget: number, voteBasis: VoteBasis): void {
  const caveat = voteBasisCaveat(veAeroBudget, voteBasis);
  if (caveat === null) return;

  const amount = Math.round(veAeroBudget).toString();
  console.log(`\n${wrapText(caveat, 92)}`);
  console.log(
    wrapText(
      `Check it at your own size: backtest --veaero ${amount} replays past epochs under both, and npm run predict-check scores their accuracy.`,
      92,
    ),
  );
}

async function cmdRecommend(args: string[]) {
  const topK = parsePositiveIntFlag(args, "top", 15);
  const minConsistency = parseUnitIntervalFlag(args, "min-consistency", 0);
  const maxWeight = parseUnitIntervalFlag(args, "max-weight", 1);
  const voteBasis = parseVoteBasisFlag(args);
  if (topK === undefined || minConsistency === undefined || maxWeight === undefined || maxWeight === 0 || voteBasis === undefined) {
    console.error(
      `${RECOMMEND_USAGE}\nK must be a positive integer; min-consistency a number from 0 to 1; max-weight a number above 0 and up to 1; vote-basis one of "previous", "current" or "typical".`,
    );
    process.exitCode = 1;
    return;
  }

  const veaero = await resolveBudget(args, RECOMMEND_USAGE);
  if (veaero === null) {
    process.exitCode = 1;
    return;
  }

  const ranked = (await rankPoolsByEfficiency()).filter((p) => p.consistency >= minConsistency);
  const allocation = recommendAllocation(ranked, veaero, topK, undefined, maxWeight, voteBasis);

  // A cap too tight for the candidate set leaves part of the budget unplaced,
  // and every downstream figure would then describe a vote that spends less
  // than the user has. Refusing here is the only honest option: printing the
  // rows anyway means toWholePercentWeights scales them back to 100% and hands
  // back exactly the concentration --max-weight was asked to prevent.
  const unplaced = unallocatedVeAero(allocation, veaero);
  if (unplaced > 0) {
    const pct = Math.round((unplaced / veaero) * 100);
    console.error(
      `--max-weight ${maxWeight} is too tight for the ${allocation.length} pool(s) that qualified: ${pct}% of your veAERO has nowhere to go. Raise --max-weight, raise --top, or lower --min-consistency.`,
    );
    process.exitCode = 1;
    return;
  }
  const totalExpectedUsd = allocation.reduce((a, b) => a + b.expectedUsd, 0);
  const votePercents = toWholePercentWeights(allocation);
  // What the rounded, actually-castable vote is worth. Not the sum above — see
  // `expectedUsdForWholePercentVote` for why the two differ in both directions.
  const votePercentsExpectedUsd = expectedUsdForWholePercentVote(allocation, veaero);

  if (hasFlag(args, "json")) {
    console.log(
      JSON.stringify(
        {
          veAeroBudget: veaero,
          maxWeight,
          voteBasis,
          voteBasisCaveat: voteBasisCaveat(veaero, voteBasis),
          allocation,
          votePercents,
          totalExpectedUsd,
          votePercentsExpectedUsd,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (allocation.length === 0) {
    // Without this, --vote-ready would print "whole percentages, summing to
    // exactly 100" followed by zero rows and $0 — actively misleading rather
    // than just empty. Mirrors the "not enough epoch history" guard in
    // cmdBacktest for the same underlying situation: nothing qualified.
    const reason =
      minConsistency > 0
        ? `No live-gauge pool passes --min-consistency ${minConsistency} right now — try a lower value.`
        : "No live-gauge pool with a big enough trailing average is available to allocate to right now.";
    console.log(`\n${reason}\n`);
    return;
  }

  if (hasFlag(args, "vote-ready")) {
    console.log(`\nVote-ready weights for ${veaero.toLocaleString("en-US", { maximumFractionDigits: 0 })} veAERO — whole percentages, summing to exactly 100:\n`);
    for (const v of votePercents) {
      console.log(`  ${v.percent.toString().padStart(3)}%  ${v.symbol}`);
    }
    const dropped = allocation.length - votePercents.length;
    console.log(`\nEnter these directly on aerodrome.finance. Expected next epoch: ${fmtUsd(votePercentsExpectedUsd)}.`);
    if (dropped > 0) {
      console.log(
        `(${dropped} pool${dropped > 1 ? "s" : ""} received a share too small to round up to 1%; those points went to the rows above.)`,
      );
    }
    console.log(epochDeadlineLine());
    printVoteBasisCaveat(veaero, voteBasis);
    console.log("\nThis tool never touches your wallet or keys.\n");
    return;
  }

  const capNote = maxWeight < 1 ? `, no pool above ${Math.round(maxWeight * 100)}%` : "";
  console.log(`\nRecommended allocation for ${veaero.toLocaleString("en-US", { maximumFractionDigits: 0 })} veAERO (top ${topK} candidates considered${capNote}):\n`);
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
  console.log(epochDeadlineLine());
  printVoteBasisCaveat(veaero, voteBasis);
  console.log("\nPass --vote-ready for whole percentages you can type straight into Aerodrome's voting UI.");
  console.log("You vote this yourself on aerodrome.finance — this tool never touches your wallet or keys.\n");
}

async function cmdBacktest(args: string[]) {
  const epochs = parsePositiveIntFlag(args, "epochs", BACKTEST_EPOCHS, MAX_BACKTEST_EPOCHS);
  const minConsistency = parseUnitIntervalFlag(args, "min-consistency", 0);
  if (epochs === undefined || minConsistency === undefined) {
    console.error(BACKTEST_USAGE);
    process.exitCode = 1;
    return;
  }

  const veaero = await resolveBudget(args, BACKTEST_USAGE);
  if (veaero === null) {
    process.exitCode = 1;
    return;
  }

  const report = await backtestLive(veaero, epochs, undefined, minConsistency);

  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.epochsTested === 0) {
    // Same distinction `recommend` draws: "there is no history" and "your filter
    // rejected all of it" call for different next moves, and one message for
    // both sends you looking for a data problem that isn't there.
    console.log(
      minConsistency > 0
        ? `\nNo epoch had a candidate pool passing --min-consistency ${minConsistency} — try a lower value.\n`
        : "\nNot enough epoch history to backtest — no epoch had a qualifying candidate pool.\n",
    );
    return;
  }

  const filterNote = minConsistency > 0 ? ` (only pools with consistency ≥ ${minConsistency})` : "";
  console.log(`\nBacktest over the last ${report.epochsTested} epoch(s) with ${veaero.toLocaleString("en-US", { maximumFractionDigits: 0 })} veAERO${filterNote}:\n`);
  console.log(
    ["EpochsAgo", "Radar $ (typical)", "Radar $ (current)", "Naive $", "Naive picked"]
      .map((h) => h.padEnd(20))
      .join(""),
  );
  for (const e of report.epochs) {
    console.log(
      [
        String(e.epochsAgo).padEnd(20),
        fmtUsd(e.radarTypicalUsd).padEnd(20),
        fmtUsd(e.radarUsd).padEnd(20),
        fmtUsd(e.naiveUsd).padEnd(20),
        e.naiveSymbol ?? "-",
      ].join(""),
    );
  }

  const uplift = report.upliftPct === null ? "n/a (baseline earned $0)" : `${(report.upliftPct * 100).toFixed(1)}%`;
  console.log(`\nTotal: radar ${fmtUsd(report.radarTotalUsd)} vs naive ${fmtUsd(report.naiveTotalUsd)} — uplift ${uplift}`);
  console.log(`Radar earned more in ${report.epochsWonByRadar} of ${report.epochsTested} epoch(s).`);

  // What the default vote basis is worth, which is the only reason it is the
  // default. Printed as its own line rather than folded into the uplift above,
  // because it answers a different question: not "does the radar beat naive
  // APR-chasing" but "does judging pools on the weight they settle at beat
  // judging them on the weight they are showing".
  const basisDelta =
    report.typicalVsCurrentPct === null
      ? "n/a (the current-weight basis earned $0)"
      : `${report.typicalVsCurrentPct >= 0 ? "+" : ""}${(report.typicalVsCurrentPct * 100).toFixed(1)}%`;
  console.log(
    `Vote basis: typical ${fmtUsd(report.radarTypicalTotalUsd)} vs current ${fmtUsd(report.radarTotalUsd)} — ${basisDelta}, ahead in ${report.epochsWonByTypical} of ${report.epochsTested} epoch(s).`,
  );

  if (minConsistency > 0) {
    // Worth stating plainly: a filter that leaves two pools to choose between
    // has changed the strategy far more than the uplift figure alone suggests.
    const excluded = report.epochs.reduce((a, e) => a + e.candidatesExcludedByConsistency, 0);
    const kept = report.epochs.reduce((a, e) => a + e.candidatesConsidered, 0);
    console.log(
      `The filter dropped ${excluded} pool-epoch(s) and left ${kept} to allocate across. The naive baseline is deliberately left unfiltered, so this uplift is comparable with an unfiltered run.`,
    );
  }
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

/**
 * Whether `command` is a request for help rather than a mistake — no arguments
 * at all, or an explicit help flag. Both print the same text; only the exit code
 * differs, because a script that runs `aero-vote-radar poolz` and reads $? needs
 * to be told it typed something wrong.
 */
function isHelpRequest(command: string | undefined): boolean {
  return command === undefined || command === "help" || command === "--help" || command === "-h";
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
    default: {
      // An unrecognised command exits non-zero: printing usage and reporting
      // success meant a typo in a script looked exactly like a completed run.
      const usage = `aero-vote-radar — Aerodrome (Base) veAERO vote-efficiency tool

Commands:
  pools [--top N] [--min-consistency 0..1] [--json]
      Rank live-gauge pools by current & predicted $/vote, with a consistency score

  recommend (--veaero N | --address 0x...) [--top K] [--min-consistency 0..1] [--max-weight 0..1] [--vote-basis previous|current|typical] [--vote-ready] [--json]
      Recommend a self-dilution-aware allocation. --address reads your live voting
      power on-chain instead of you typing the amount; --vote-basis picks which
      vote weight pools are judged against (default: previous, the weight the pool
      settled at last epoch); --vote-ready prints whole percentages that sum to
      100, ready for Aerodrome's voting UI.

  backtest (--veaero N | --address 0x...) [--epochs N] [--min-consistency 0..1] [--json]
      Replay past epochs (up to ${MAX_BACKTEST_EPOCHS}) and compare this tool's allocation against the
      naive "vote for the highest current $/vote" strategy. Pass the same
      --min-consistency you vote with, so the backtest tests the strategy you
      actually run; the naive baseline stays unfiltered either way.

  my-veaero <address> [--json]
      Look up an account's veAERO locks and voting power

Pass --json to any command for machine-readable output instead of a table.
`;
      if (isHelpRequest(command)) {
        console.log(usage);
        return;
      }
      console.error(`Unknown command: ${command}
`);
      console.error(usage);
      process.exitCode = 1;
      return;
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${formatError(err)}`);
  process.exitCode = 1;
});
