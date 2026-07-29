// Verified against https://raw.githubusercontent.com/velodrome-finance/sugar/master/deployments/base.env
// and cross-checked on Basescan (contract names LpSugar / RewardsSugar match).
export const BASE_CHAIN_ID = 8453;

// Overridable via env var so users with their own Base RPC (Alchemy, Infura, etc.)
// get a much higher rate-limit ceiling than the shared public endpoints.
export const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";

export const VOTER_ADDRESS = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as const;
export const REWARDS_SUGAR_ADDRESS = "0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678" as const;
export const VE_SUGAR_ADDRESS = "0x4d6A741cEE6A8cC5632B2d948C050303F6246D24" as const;

// How many trailing weekly epochs to pull per pool for the trend estimate.
export const TREND_EPOCHS = 6;

// Pools whose trailing-average epoch value is below this are excluded from
// rankings — at that size, one small one-off bribe swings the "predictive edge"
// percentage wildly without representing a meaningful voting opportunity.
export const MIN_TRAILING_USD = 10;

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

// How long a looked-up (or $0-fallback) price stays valid before it's refetched.
// The CLI is a fresh process per invocation so this never matters there, but
// mcp-server.ts holds one process open for the life of a client connection —
// without a TTL, prices (and any transient-failure $0 fallback) would be cached
// forever for that process, silently going stale or permanently mispricing a
// token that only failed to price once.
export const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
