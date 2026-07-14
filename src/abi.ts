// Minimal ABIs: only the read methods this project actually calls.
// Struct field order transcribed directly from the official Vyper sources
// (velodrome-finance/sugar, contracts/{LpSugar,RewardsSugar,VeSugar}.vy) —
// Aerodrome is a fork of Velodrome and shares this tooling/deployment pattern.

const LP_TUPLE_COMPONENTS = [
  { name: "lp", type: "address" },
  { name: "symbol", type: "string" },
  { name: "decimals", type: "uint8" },
  { name: "liquidity", type: "uint256" },
  { name: "type", type: "int24" },
  { name: "tick", type: "int24" },
  { name: "sqrt_ratio", type: "uint160" },
  { name: "token0", type: "address" },
  { name: "reserve0", type: "uint256" },
  { name: "staked0", type: "uint256" },
  { name: "token1", type: "address" },
  { name: "reserve1", type: "uint256" },
  { name: "staked1", type: "uint256" },
  { name: "gauge", type: "address" },
  { name: "gauge_liquidity", type: "uint256" },
  { name: "gauge_alive", type: "bool" },
  { name: "fee", type: "address" },
  { name: "bribe", type: "address" },
  { name: "factory", type: "address" },
  { name: "emissions", type: "uint256" },
  { name: "emissions_token", type: "address" },
  { name: "emissions_cap", type: "uint256" },
  { name: "pool_fee", type: "uint256" },
  { name: "unstaked_fee", type: "uint256" },
  { name: "token0_fees", type: "uint256" },
  { name: "token1_fees", type: "uint256" },
  { name: "locked", type: "uint256" },
  { name: "emerging", type: "uint256" },
  { name: "created_at", type: "uint32" },
  { name: "nfpm", type: "address" },
  { name: "alm", type: "address" },
  { name: "root", type: "address" },
] as const;

export const LP_SUGAR_ABI = [
  {
    type: "function",
    name: "all",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_filter", type: "uint256" },
    ],
    outputs: [{ name: "", type: "tuple[]", components: LP_TUPLE_COMPONENTS }],
  },
  {
    type: "function",
    name: "byAddress",
    stateMutability: "view",
    inputs: [{ name: "_address", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: LP_TUPLE_COMPONENTS }],
  },
] as const;

// Voter is the source of truth for "which pools can receive votes at all" — its
// `pools` array only contains pools that had a gauge created for them (~1.8k),
// versus LpSugar's `all()` which scans literally every pool the factory has ever
// created (~28k, mostly long-tail pairs that were never gauged). Enumerating via
// Voter + isAlive is dramatically cheaper than paginating the whole factory.
// Every Aerodrome pool is itself an ERC20-like LP token exposing these directly —
// reading them straight from the pool avoids LpSugar's byAddress() entirely,
// which turned out to internally linear-scan up to 30,000 pools per lookup and
// reliably exceed a public RPC's default eth_call gas allowance.
export const POOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const VOTER_ABI = [
  {
    type: "function",
    name: "length",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "pools",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "gauges",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isAlive",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const LP_EPOCH_REWARD_COMPONENTS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

const LP_EPOCH_COMPONENTS = [
  { name: "ts", type: "uint256" },
  { name: "lp", type: "address" },
  { name: "votes", type: "uint256" },
  { name: "emissions", type: "uint256" },
  { name: "bribes", type: "tuple[]", components: LP_EPOCH_REWARD_COMPONENTS },
  { name: "fees", type: "tuple[]", components: LP_EPOCH_REWARD_COMPONENTS },
] as const;

export const REWARDS_SUGAR_ABI = [
  {
    type: "function",
    name: "epochsByAddress",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_address", type: "address" },
    ],
    outputs: [{ name: "", type: "tuple[]", components: LP_EPOCH_COMPONENTS }],
  },
] as const;

const LP_VOTES_COMPONENTS = [
  { name: "lp", type: "address" },
  { name: "weight", type: "uint256" },
] as const;

const VE_NFT_COMPONENTS = [
  { name: "id", type: "uint256" },
  { name: "account", type: "address" },
  { name: "decimals", type: "uint8" },
  { name: "amount", type: "uint128" },
  { name: "voting_amount", type: "uint256" },
  { name: "governance_amount", type: "uint256" },
  { name: "rebase_amount", type: "uint256" },
  { name: "expires_at", type: "uint256" },
  { name: "voted_at", type: "uint256" },
  { name: "votes", type: "tuple[]", components: LP_VOTES_COMPONENTS },
] as const;

export const VE_SUGAR_ABI = [
  {
    type: "function",
    name: "byAccount",
    stateMutability: "view",
    inputs: [{ name: "_account", type: "address" }],
    outputs: [{ name: "", type: "tuple[]", components: VE_NFT_COMPONENTS }],
  },
] as const;
