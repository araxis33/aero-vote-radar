// Verified against https://raw.githubusercontent.com/velodrome-finance/sugar/master/deployments/base.env
// and cross-checked on Basescan (contract names LpSugar / RewardsSugar match).
export const BASE_CHAIN_ID = 8453;

// Overridable via env var so users with their own Base RPC (Alchemy, Infura, etc.)
// get a much higher rate-limit ceiling than the shared public endpoints.
export const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";

export const VOTER_ADDRESS = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as const;
export const REWARDS_SUGAR_ADDRESS = "0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678" as const;
// VotingEscrow (the veAERO NFT contract). Obtained by calling `Voter.ve()` on
// the address above rather than copied from docs, and re-verified 2026-08-08.
// Replaces VeSugar, whose `byAccount` reverts on a public RPC for accounts with
// many locks — see the comment on VOTING_ESCROW_ABI in abi.ts.
export const VOTING_ESCROW_ADDRESS = "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4" as const;

// How many trailing weekly epochs to pull per pool for the trend estimate.
export const TREND_EPOCHS = 6;

// How many past epochs the `backtest` command replays by default. Each tested
// epoch needs its own full TREND_EPOCHS window of *older* history to form the
// estimate it would have had at the time, so the on-chain fetch depth is
// BACKTEST_EPOCHS + TREND_EPOCHS. RewardsSugar keeps plenty of history, but
// every extra epoch is more data per pool across hundreds of pools, so this
// stays modest by default and is overridable with `--epochs`.
export const BACKTEST_EPOCHS = 6;

// Upper bound on `--epochs`/`epochs` for the backtest command and MCP tool. The
// on-chain fetch depth (BACKTEST_EPOCHS + TREND_EPOCHS worth of epochs, per
// pool) scales directly with this, across every live-gauge pool — an unbounded
// value here means one mistyped flag (or an agent-supplied argument) turns
// into an enormous multi-hundred-pool fetch against a shared public RPC.
export const MAX_BACKTEST_EPOCHS = 20;

// Pools whose trailing-average epoch value is below this are excluded from
// rankings — at that size, one small one-off bribe swings the "predictive edge"
// percentage wildly without representing a meaningful voting opportunity.
export const MIN_TRAILING_USD = 10;

// Floor, in veAERO, below which a pool's vote weight is too small to form a
// ratio against. `refillRatio` divides a pool's typical settled weight by its
// current one, and both sides of that division need to be a real number of
// votes: measured on live data, an unfloored version topped the "will be
// refilled" list with a pool holding 1,364 votes against a history of zero,
// reporting a 2,577x refill that described nothing. Same reasoning as
// MIN_TRAILING_USD, applied to the denominator instead of the numerator.
export const MIN_VOTE_BASELINE = 1000;

export const DEFILLAMA_PRICE_URL = "https://coins.llama.fi/prices/current";

// Bounds how long a single DefiLlama batch request can hang before it's treated
// as a failure. Without this, a stalled connection (no response, no error) never
// resolves or rejects, so a hung request would block a whole ranking run forever
// — and for mcp-server.ts, which holds one process open across many tool calls,
// that wedges every future call too, not just the one that hit it.
export const DEFILLAMA_TIMEOUT_MS = 8000;

// Max token addresses per DefiLlama price request. A run can touch bribe/fee
// tokens across hundreds of live-gauge pools, and one comma-joined URL covering
// all of them at once risks tripping URL-length limits on DefiLlama's edge/CDN —
// which would silently zero out pricing for every token in the run, not just the
// ones that were actually the problem. Batching bounds the blast radius of a
// single failed/oversized request to just that batch.
export const PRICE_BATCH_SIZE = 50;

// How many DefiLlama batch requests run at once. Bounded rather than unbounded
// (a run can produce several batches) so a burst of simultaneous requests
// doesn't look like abuse to DefiLlama's edge/CDN — matches the concurrency
// cap already used for Base RPC calls in pools.ts/efficiency.ts/backtest.ts.
export const PRICE_BATCH_CONCURRENCY = 4;

// How long a successfully looked-up price stays valid before it's refetched.
// The CLI is a fresh process per invocation so this never matters there, but
// mcp-server.ts holds one process open for the life of a client connection —
// without a TTL, prices would be cached forever for that process and silently
// go stale.
export const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

// How long the $0 fallback stays valid — much shorter than a real price, and
// deliberately so. The two are not the same kind of fact: a real price is
// information that ages slowly, while a $0 fallback is the absence of one, and
// it is written both for tokens DefiLlama genuinely doesn't price and for a
// batch that merely failed to reach it. Caching those together for five minutes
// meant one timed-out request could value a token at $0 across a whole run of
// mcp-server.ts calls — enough to drop real pools below MIN_TRAILING_USD and
// reorder a ranking, with nothing in the output saying why. At 30s a transient
// failure costs one refetch; a genuinely unpriced token costs a cheap retry per
// batch, since it is looked up alongside the rest of its batch either way.
export const PRICE_FAILURE_CACHE_TTL_MS = 30 * 1000;
