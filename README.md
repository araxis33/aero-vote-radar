# aero-vote-radar

[![CI](https://github.com/araxis33/aero-vote-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/araxis33/aero-vote-radar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An MCP server + CLI that reads **live on-chain data** from [Aerodrome Finance](https://aerodrome.finance) (Base) to rank pools by veAERO vote efficiency, and recommends a vote allocation that accounts for **self-dilution** — the fact that adding more of your own votes to a pool measurably lowers your own $-per-vote there, which naive "just vote where APR looks highest" approaches ignore.

No API keys, no backend, no database. Every number comes from Aerodrome's own official on-chain "Sugar" contracts and the `Voter` contract, read live off Base mainnet, plus [DefiLlama](https://defillama.com)'s free price API to convert bribe/fee tokens to USD.

**This tool never touches a wallet or private key.** It outputs a recommendation — weights and expected USD — and you vote it yourself on [aerodrome.finance](https://aerodrome.finance).

## Why

Aerodrome pools receive weekly bribes + trading fees, split pro-rata among everyone who voted for that pool with their veAERO. Two things make "just vote for the highest-APR pool" a bad strategy:

1. **Self-dilution.** The moment you add votes to a pool, you've changed its vote total, and your own share (and everyone else's) goes down. A pool that looks great before your vote can look mediocre after it, especially if you have a large veAERO balance relative to the pool's existing votes.
2. **Lag.** The leaderboard everyone looks at is *last epoch's* result. Pools where incentives are trending up faster than votes have caught up are where the actual opportunity is — by the time it's obvious, the vote weight has already caught up too.

`aero-vote-radar` addresses both: it ranks pools using a trailing-average trend estimate instead of just the latest epoch, and it allocates using a greedy marginal-value algorithm that models dilution explicitly.

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
- **`Voter.pools()` currently lists ~1,830 pools that have ever had a gauge; ~110–220 pass a minimum trailing-value floor** (pools below ~$10/epoch trailing value are excluded — at that size a single small one-off bribe swings the "edge" percentage wildly without being a meaningful signal). A few hundred Voter-registered entries fail basic ERC20 calls (non-standard/likely cross-chain relay entries) and are skipped with a warning rather than failing the whole run.

## Install

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
npx tsx src/cli.ts pools --top 10 --json
npx tsx src/cli.ts recommend --veaero 25000
npx tsx src/cli.ts my-veaero 0xYourAddress
npx tsx src/cli.ts my-veaero 0xYourAddress --json
```

Pass `--json` to any command for machine-readable output instead of a table — useful for piping into other scripts or tools.

Real output from a live run (Base mainnet, no mocking):

```
$ npx tsx src/cli.ts pools --top 5

Top 5 Aerodrome pools by predicted $/veAERO vote (of 110 live-gauge pools with votes):

Symbol            Votes(veAERO)     Latest $/vote     Predicted $/vote  Edge
vAMM-USDC/SQD     11,724            $0.000655         $0.04             5445.3%
vAMM-FLOCK/VVV    5,626             $0.004693         $0.01             154.7%
vAMM-OVN/USD+     52,409            $0.000558         $0.009986         1688.5%
sAMM-msUSD/frxUSD 42,516            $0.002617         $0.009684         270.1%
sAMM-BOLD/USDC    1,112             $0.003981         $0.009008         126.3%
```

```
$ npx tsx src/cli.ts recommend --veaero 25000

Recommended allocation for 25,000 veAERO (top 15 candidates considered):

Symbol            Weight            veAERO            Expected $/epoch
vAMM-USDC/SQD     53.0%             13,250            $225.97
vAMM-OVN/USD+     24.5%             6,125             $54.76
sAMM-msUSD/frxUSD 17.0%             4,250             $37.42
vAMM-FLOCK/VVV    5.0%              1,250             $12.23
sAMM-BOLD/USDC    0.5%              125               $1.01

Total expected value next epoch (heuristic, trailing-average based): $331.38
You vote this yourself on aerodrome.finance — this tool never touches your wallet or keys.
```

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

or, after `npm run build` and `npm link` / publishing, point any MCP-capable agent (Claude, etc.) at the `aero-vote-radar-mcp` binary. It exposes three tools:

- **`list_pool_efficiency`** — ranked pools with current + predicted $/vote and predictive edge.
- **`recommend_allocation`** — given a veAERO amount, returns weights + expected USD per pool.
- **`get_my_veaero`** — looks up an account's veAERO locks and total voting power.

Example agent prompt: *"Using aero-vote-radar, recommend an allocation for my 25,000 veAERO."*

## Project layout

```
src/
  constants.ts     verified Base mainnet contract addresses
  abi.ts           minimal ABIs (only the methods this project calls)
  chain.ts         viem public client (Base RPC, retry/batch configured)
  prices.ts        DefiLlama USD price lookup + cache
  pools.ts         pool discovery (Voter) + epoch history (RewardsSugar)
  efficiency.ts    current & trend-predicted $/vote ranking
  allocator.ts     greedy marginal ("water-filling") allocation algorithm
  veAero.ts        VeSugar wrapper for a user's voting power
  mcp-server.ts    MCP stdio server entrypoint
  cli.ts           CLI entrypoint
test/
  allocator.test.ts   unit tests for the greedy marginal-allocation algorithm
  efficiency.test.ts  unit tests for per-pool efficiency math (trailing average, $/vote, predictive edge)
  prices.test.ts      unit tests for DefiLlama price lookup, batching, and USD conversion
  util.test.ts        unit tests for isValidAddress and mapWithConcurrency
  cli.test.ts         unit tests for CLI flag parsing
```

## Testing

```bash
npm test
```

Tests cover the allocator (`recommendAllocation`) with synthetic pool data — budget conservation, that a single candidate gets 100% of the allocation, that `topK` is actually respected, and specifically that **self-dilution works**: two pools with identical incentives and existing votes get split roughly evenly under a large budget instead of an APR-only optimizer dumping everything into one. The pure per-pool efficiency math (`computePoolEfficiency`/`epochUsd` in `efficiency.ts`) is covered the same way — trailing-average computation, the `MIN_TRAILING_USD` cutoff, the zero-votes exclusion, and the `predictiveEdge` divide-by-zero guard — plus DefiLlama pricing/batching (`prices.ts`), CLI flag parsing (`cli.ts`), and the address/concurrency helpers (`util.ts`), all with synthetic inputs and no network access. The remaining on-chain data-fetching code (`fetchActivePools`/`fetchPoolEpochs` in `pools.ts`, `fetchVeAeroPositions` in `veAero.ts`) is exercised live against Base mainnet via the CLI instead — see the real example output above.

CI (`.github/workflows/ci.yml`) runs the typecheck, build, and test suite on every push.

## License

MIT
