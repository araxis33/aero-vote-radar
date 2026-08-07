# aero-vote-radar

[![CI](https://github.com/araxis33/aero-vote-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/araxis33/aero-vote-radar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An MCP server + CLI that reads **live on-chain data** from [Aerodrome Finance](https://aerodrome.finance) (Base) to rank pools by veAERO vote efficiency, and recommends a vote allocation that accounts for **self-dilution** — the fact that adding more of your own votes to a pool measurably lowers your own $-per-vote there, which naive "just vote where APR looks highest" approaches ignore.

No API keys, no backend, no database. Every number comes from Aerodrome's own official on-chain "Sugar" contracts and the `Voter` contract, read live off Base mainnet, plus [DefiLlama](https://defillama.com)'s free price API to convert bribe/fee tokens to USD.

**This tool never touches a wallet or private key.** It outputs a recommendation — weights and expected USD — and you vote it yourself on [aerodrome.finance](https://aerodrome.finance).

**No install needed:** there's a hosted version at **[aero.deftools.xyz](https://aero.deftools.xyz)** — enter your veAERO amount and it gives you vote-ready percentages. See [Web app](#web-app) for how it stays current.

## Why

Aerodrome pools receive weekly bribes + trading fees, split pro-rata among everyone who voted for that pool with their veAERO. Two things make "just vote for the highest-APR pool" a bad strategy:

1. **Self-dilution.** The moment you add votes to a pool, you've changed its vote total, and your own share (and everyone else's) goes down. A pool that looks great before your vote can look mediocre after it, especially if you have a large veAERO balance relative to the pool's existing votes.
2. **Lag.** The leaderboard everyone looks at is *last epoch's* result. Pools where incentives are trending up faster than votes have caught up are where the actual opportunity is — by the time it's obvious, the vote weight has already caught up too.

3. **One-off bribes masquerading as opportunities.** A pool that got a single $600 bribe five weeks ago and nothing since has the same trailing average as one that pays $100 like clockwork — but voting into the first is a bet that a one-week event repeats.

`aero-vote-radar` addresses all three: it ranks pools using a trailing-average trend estimate instead of just the latest epoch, scores how *steady* each pool's incentives have actually been, and allocates using a greedy marginal-value algorithm that models dilution explicitly. It also ships a `backtest` command that replays past epochs so the claim "this beats naive APR-chasing" can be checked rather than taken on faith.

## How it works

| Data | Source | Contract (Base mainnet) |
|---|---|---|
| Which pools can receive votes, which gauges are alive | `Voter` | `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5` |
| Pool token/symbol metadata | the pool contracts themselves (ERC20-like) | (per-pool) |
| Weekly epoch history — votes, bribes, fees | `RewardsSugar` | `0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678` |
| Your veAERO locks & voting power | `VeSugar` | `0x4d6A741cEE6A8cC5632B2d948C050303F6246D24` |
| USD pricing for bribe/fee tokens | [DefiLlama](https://defillama.com) `coins.llama.fi` (free, keyless) | — |

All addresses are pulled from Aerodrome/Velodrome's own [official Sugar deployment file](https://github.com/velodrome-finance/sugar/blob/master/deployments/base.env) and cross-checked against verified contract names on Basescan.

Two things worth calling out honestly, so the tool isn't oversold:

- **"Predicted" is a trailing average, not machine learning.** `predictedValuePerVote` = mean(last 6 epochs' USD value) ÷ current votes. It's a simple, transparent heuristic for "which pools are trending," not a forecast model.
- **The allocator assumes other voters' votes stay put.** The greedy marginal algorithm optimizes your allocation against the *current snapshot* of everyone else's votes. It doesn't (and can't) predict how other voters will react to your vote.
- **`consistency` is a description of the past, not a promise about the future.** It's `1 / (1 + coefficient of variation)` over the observed epochs: 1.00 means the pool paid the same every epoch, lower means spikier. A pool with only one observed epoch scores 0 rather than 1 — a single data point can't demonstrate steadiness, and scoring it as perfect would flatter brand-new pools exactly where the tool should be most cautious. Use `epochsObserved` to tell "unproven" apart from "genuinely erratic".
- **The backtest is a small sample with survivorship bias.** It only sees pools whose gauge is still alive today, and it assumes your votes wouldn't have changed anyone else's behaviour. Treat a handful of epochs as a sanity check, not a track record.
- **`Voter.pools()` currently lists ~1,830 pools that have ever had a gauge; ~110–220 pass a minimum trailing-value floor** (pools below ~$10/epoch trailing value are excluded — at that size a single small one-off bribe swings the "edge" percentage wildly without being a meaningful signal). A few hundred Voter-registered entries fail basic ERC20 calls (non-standard/likely cross-chain relay entries) and are skipped with a warning rather than failing the whole run.

## Web app

[aero.deftools.xyz](https://aero.deftools.xyz) is the same ranking and the same allocator, without installing anything.

It exists because the two halves of this tool have very different costs. The **scan** is heavy — one epoch-history call per live-gauge pool, several hundred of them — which a visitor's browser cannot do against a public RPC without being rate-limited into uselessness. The **allocation** is just arithmetic over an already-scanned list, and is instant.

So they're split:

- A scheduled job (`.github/workflows/snapshot.yml`, every 6 hours) runs `npm run snapshot`, which performs the full live scan and writes [`docs/data/snapshot.json`](docs/data/snapshot.json). If the file changed, the job commits it. A scan that returns zero pools throws instead of publishing, so a rate-limited run can't blank out yesterday's perfectly good data.
- [`docs/index.html`](docs/index.html) fetches that JSON and runs `allocateAcrossCandidates` + `toWholePercentWeights` — ported verbatim from `src/allocator.ts` — in the browser, per keystroke.

Nothing is sent anywhere: the page is a static file plus a JSON file, with no backend and no analytics. Because the personalised half runs client-side, changing your veAERO amount doesn't trigger a re-scan, and the snapshot can be shared by every visitor.

The site is served by GitHub Pages from the `docs/` folder on `main`. To regenerate the snapshot by hand:

```bash
npm run snapshot                      # writes docs/data/snapshot.json
npm run snapshot -- some/other.json   # or somewhere else
```

**Verified parity:** for 25,000 veAERO with no consistency filter, the page and `npm run cli -- recommend --veaero 25000 --vote-ready` produce the same weights (76/20/2/1/1) and the same expected total, to the cent.

## Install

Requires Node.js 18.18 or newer (the test suite's `node --import tsx` invocation depends on the `--import` flag, added in 18.18).

```bash
git clone https://github.com/araxis33/aero-vote-radar
cd aero-vote-radar
npm install
npm run build
```

Optionally set your own Base RPC for a much higher rate-limit ceiling than the shared public endpoints:

```bash
export BASE_RPC_URL="https://your-rpc-provider.example/..."
```

## CLI usage

```bash
npx tsx src/cli.ts pools --top 10
npx tsx src/cli.ts pools --top 10 --min-consistency 0.5
npx tsx src/cli.ts recommend --veaero 25000
npx tsx src/cli.ts recommend --address 0xYourAddress --vote-ready
npx tsx src/cli.ts backtest --veaero 25000 --epochs 5
npx tsx src/cli.ts my-veaero 0xYourAddress
npx tsx src/cli.ts my-veaero 0xYourAddress --json
```

Pass `--json` to any command for machine-readable output instead of a table — useful for piping into other scripts or tools.

`recommend` and `backtest` take **either** `--veaero <amount>` **or** `--address <0x...>`; with an address they read your live voting power off-chain so you don't have to look it up and retype it.

Real output from live runs (Base mainnet, no mocking):

```
$ npx tsx src/cli.ts pools --top 8

Top 8 Aerodrome pools by predicted $/veAERO vote (of 101 live-gauge pools with votes):

Symbol            Votes(veAERO)     Latest $/vote     Predicted $/vote  Edge              Consistency
vAMM-cbBTC/CHAMP  7,681             $0.000963         $0.1              10440.0%          0.35
vAMM-1000X/WETH   893               $0.003128         $0.02             478.0%            0.54
vAMM-WETH/FAI     1,242             $0.01             $0.01             -3.6%             0.54
sAMM-WETH/msETH   494,716           $0.007752         $0.01             33.7%             0.68
vAMM-USDC/SEND    1,344             $0.009698         $0.01             5.0%              0.60
vAMM-cbBTC/EDGE   67,411            $0.002594         $0.009726         275.0%            0.41
vAMM-WETH/EURC    6,197             $0.000258         $0.006274         2334.5%           0.57
vAMM-YFI/wstETH   146,052           $0.002505         $0.006189         147.1%            0.44
```

That top row is exactly why `consistency` exists: a 10,440% "edge" on 0.35 consistency is one big one-off bribe, not a repeatable weekly opportunity. `--min-consistency 0.5` filters that class of pool out entirely.

`--vote-ready` prints whole percentages that sum to exactly 100, which is what Aerodrome's voting UI accepts — rounding each weight independently tends to total 101% or 102% and leaves you fudging the last row by hand:

```
$ npx tsx src/cli.ts recommend --address 0x28aa...0108 --vote-ready --min-consistency 0.5

Using 11,491,441.934 veAERO of live voting power from 0x28aa...0108 (2 lock(s)).

Vote-ready weights for 11,491,442 veAERO — whole percentages, summing to exactly 100:

   51%  vAMM-VIRTUAL/WETH
   25%  sAMM-WETH/msETH
   18%  vAMM-WETH/MET
    2%  vAMM-WETH/DRV
    2%  vAMM-wBLT/BMX
    1%  vAMM-WETH/GHST
    1%  vAMM-Anon/USDC

Enter these directly on aerodrome.finance. Expected next epoch: $11,013.66.
```

```
$ npx tsx src/cli.ts backtest --veaero 25000 --epochs 5

Backtest over the last 5 epoch(s) with 25,000 veAERO:

EpochsAgo         Radar $           Naive $           Naive picked
0                 $137.3            $2.7              vAMM-1000X/WETH
1                 $12.82            $13.32            vAMM-WETH/RWAX
2                 $16.84            $3.34             vAMM-WETH/AIXCB
3                 $17.02            $5.17             vAMM-WETH/FAI
4                 $16.28            $6.39             vAMM-USDC/SQD

Total: radar $200.26 vs naive $30.91 — uplift 547.8%
Radar earned more in 4 of 5 epoch(s).
```

Read that with the caveats above in mind: 4-of-5 epochs is encouraging, but one epoch (`0`) supplies most of the total, and five weekly epochs is a small sample. The point of the command is that you can re-run it yourself rather than trust the claim.

```
$ npx tsx src/cli.ts my-veaero 0x28aa4F9ffe21365473B64C161b566C3CdeAD0108

veAERO locks for 0x28aa4F9ffe21365473B64C161b566C3CdeAD0108:

  NFT #6: 11,362,738.622 veAERO voting power, expires never (permanent lock)
  NFT #17324: 107,871.726 veAERO voting power, expires never (permanent lock)

Total voting power: 11,470,610.348 veAERO
```

## As an MCP server

```bash
npx tsx src/mcp-server.ts
```

or, after `npm run build` and `npm link` / publishing, point any MCP-capable agent (Claude, etc.) at the `aero-vote-radar-mcp` binary. It exposes four tools:

- **`list_pool_efficiency`** — ranked pools with current + predicted $/vote, predictive edge, and consistency. Optional `minConsistency` filter.
- **`recommend_allocation`** — given a veAERO amount *or* a wallet `address` to read it from, returns weights, whole-percent vote weights, and expected USD per pool.
- **`backtest_strategy`** — replays past epochs and compares this strategy against naive APR-chasing.
- **`get_my_veaero`** — looks up an account's veAERO locks and total voting power.

Example agent prompts:

- *"Using aero-vote-radar, recommend an allocation for my 25,000 veAERO."*
- *"Work out my veAERO from 0xMyAddress and give me vote weights I can type straight into Aerodrome, skipping pools with consistency below 0.5."*
- *"Backtest the aero-vote-radar strategy over the last 6 epochs with 25,000 veAERO."*

## Project layout

```
src/
  constants.ts     verified Base mainnet contract addresses
  abi.ts           minimal ABIs (only the methods this project calls)
  chain.ts         viem public client (Base RPC, retry/batch configured)
  prices.ts        DefiLlama USD price lookup + cache
  pools.ts         pool discovery (Voter) + epoch history (RewardsSugar)
  efficiency.ts    current & trend-predicted $/vote ranking + consistency scoring
  allocator.ts     greedy marginal ("water-filling") allocation + whole-percent vote weights
  backtest.ts      replays past epochs to score this strategy against naive APR-chasing
  veAero.ts        VeSugar wrapper for a user's voting power
  util.ts          address/concurrency helpers + shared error-message formatting
  snapshot.ts      builds the JSON snapshot the web app reads
  mcp-server.ts    MCP stdio server entrypoint
  cli.ts           CLI entrypoint
  snapshot-cli.ts  entrypoint for the scheduled snapshot job
docs/              the web app, served by GitHub Pages
  index.html       static page: reads the snapshot, runs the allocator client-side
  data/
    snapshot.json  latest scan, refreshed every 6 hours by CI
test/
  allocator.test.ts   unit tests for the greedy marginal-allocation algorithm and percentage rounding
  backtest.test.ts    unit tests for the backtester, including that it never peeks at the epoch under test
  efficiency.test.ts  unit tests for per-pool efficiency math (trailing average, $/vote, predictive edge, consistency)
  prices.test.ts      unit tests for DefiLlama price lookup, batching, and USD conversion
  veAero.test.ts      unit tests for the veAERO NFT summary mapping (toVeNftSummary)
  util.test.ts        unit tests for isValidAddress, mapWithConcurrency, and formatError
  cli.test.ts         unit tests for CLI flag parsing
  snapshot.test.ts    unit tests for the published snapshot shape
```

## Testing

```bash
npm test
```

Tests cover the allocator (`recommendAllocation`) with synthetic pool data — budget conservation, that a single candidate gets 100% of the allocation, that `topK` is actually respected, and specifically that **self-dilution works**: two pools with identical incentives and existing votes get split roughly evenly under a large budget instead of an APR-only optimizer dumping everything into one. `toWholePercentWeights` is tested to always total exactly 100 (six equal weights land on 4x17 + 2x16, not six 17s summing to 102), including on real `recommendAllocation` output. The backtester (`runBacktest`) is tested for the property that matters most in a backtest — **no lookahead**: a pool that pays a $10,000 jackpot in the epoch under test but was worth $0 in every epoch before it must not be picked, and its jackpot must not appear in the result. It's also checked against the dilution maths directly (budget equal to a pool's existing votes earns exactly half the pot), for beating the naive all-in baseline when the budget is large relative to pool votes, and for returning `null` uplift rather than dividing by a zero baseline. The pure per-pool efficiency math (`computePoolEfficiency`/`epochUsd`/`computeConsistency` in `efficiency.ts`) is covered the same way — trailing-average computation, the `MIN_TRAILING_USD` cutoff, the zero-votes exclusion, the `predictiveEdge` divide-by-zero guard, and that a $600-then-nothing pool scores far below a steady $100/epoch pool with the same average — plus DefiLlama pricing/batching (`prices.ts`), the veAERO NFT summary mapping (`toVeNftSummary` in `veAero.ts`, including permanent-lock and large-id precision handling), CLI flag parsing (`cli.ts`), and the address/concurrency/error-formatting helpers (`util.ts`), all with synthetic inputs and no network access. `formatError` (in `util.ts`) reduces a thrown error to a single clean line — preferring viem's concise `.shortMessage` over its multi-paragraph `.message` — and is shared by both the CLI's top-level error output and every MCP tool handler's error result, so a failed RPC call surfaces the same readable message however the tool is invoked. The remaining on-chain data-fetching code (`fetchActivePools`/`fetchPoolEpochs` in `pools.ts`, `fetchVeAeroPositions` in `veAero.ts`) is exercised live against Base mainnet via the CLI instead — see the real example output above.

CI (`.github/workflows/ci.yml`) runs the typecheck, build, and test suite on every push.

## License

MIT
