#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rankPoolsByEfficiency } from "./efficiency.js";
import { recommendAllocation, toWholePercentWeights } from "./allocator.js";
import { backtestLive } from "./backtest.js";
import { fetchVeAeroPositions } from "./veAero.js";
import { BACKTEST_EPOCHS } from "./constants.js";
import { formatError, isValidAddress } from "./util.js";

/**
 * Resolves a veAERO budget from either an explicit amount or a wallet address,
 * shared by the allocation and backtest tools so both accept the same input.
 */
async function resolveVeAeroBudget(veAero?: number, address?: string): Promise<number> {
  if (veAero !== undefined && address !== undefined) {
    throw new Error("Pass either veAero or address, not both.");
  }
  if (address !== undefined) {
    const positions = await fetchVeAeroPositions(address);
    const total = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);
    if (total <= 0) throw new Error(`No veAERO voting power found for ${address} — nothing to allocate.`);
    return total;
  }
  if (veAero === undefined) throw new Error("Provide either veAero (an amount) or address (a wallet to read it from).");
  return veAero;
}

/**
 * Wraps a tool handler so a thrown error (almost always a failed RPC or
 * price-lookup call, since this server holds one process open across many
 * calls) comes back as a clean one-line `formatError` message instead of the
 * MCP SDK's own catch-all, which surfaces viem's raw `.message` — a
 * multi-paragraph dump of docs links and version info that buries the actual
 * problem for whatever agent is consuming this tool.
 */
function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<{ content: { type: "text"; text: string }[] }>,
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
    }
  };
}

const server = new McpServer({
  name: "aero-vote-radar",
  version: "0.1.0",
});

server.registerTool(
  "list_pool_efficiency",
  {
    title: "List Aerodrome pool vote efficiency",
    description:
      "Ranks all live-gauge Aerodrome (Base) pools by current and trend-predicted USD value per veAERO vote, using live on-chain data from Aerodrome's Sugar contracts plus DefiLlama USD pricing. 'Predicted' is a simple trailing average of recent epochs, not a machine-learning forecast.",
    inputSchema: {
      top: z.number().int().positive().max(100).optional().describe("How many top pools to return (default 20)"),
      minConsistency: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Only include pools whose consistency score is at least this (0..1). 1.00 = identical payout every epoch; a low score usually means one big one-off bribe rather than a repeatable opportunity."),
    },
  },
  withErrorHandling(async ({ top = 20, minConsistency = 0 }) => {
    const ranked = await rankPoolsByEfficiency();
    const eligible = ranked.filter((p) => p.consistency >= minConsistency);
    const rows = eligible.slice(0, top).map((p) => ({
      pool: p.pool.address,
      symbol: p.pool.symbol,
      currentVotesVeAero: p.currentVotesVeAero,
      currentValuePerVoteUsd: p.currentValuePerVote,
      predictedValuePerVoteUsd: p.predictedValuePerVote,
      predictiveEdgePct: p.predictiveEdge * 100,
      epochsObserved: p.epochsObserved,
      volatility: p.volatility,
      consistency: p.consistency,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ poolsConsidered: ranked.length, poolsPassingConsistency: eligible.length, top: rows }, null, 2),
        },
      ],
    };
  }),
);

server.registerTool(
  "recommend_allocation",
  {
    title: "Recommend a veAERO vote allocation",
    description:
      "Given a veAERO amount, recommends how to split votes across the current highest-efficiency Aerodrome pools using a greedy marginal-value ('water-filling') algorithm that accounts for self-dilution — voting more of your own veAERO into a pool measurably lowers your own $-per-vote there. Output is weights and expected USD only; this tool never touches a wallet, private key, or sends any transaction. The user reviews the recommendation and votes themselves on aerodrome.finance.",
    inputSchema: {
      veAero: z.number().positive().finite().optional().describe("Amount of veAERO voting power to allocate. Omit this if you pass `address` instead."),
      address: z
        .string()
        .refine(isValidAddress, "Must be a 0x-prefixed 40-character hex address")
        .optional()
        .describe("Base wallet address to read live voting power from, instead of stating an amount. Pass either this or veAero, not both."),
      topCandidates: z.number().int().positive().max(50).optional().describe("How many top-ranked pools to consider as candidates (default 15)"),
      minConsistency: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Only allocate to pools whose consistency score is at least this (0..1), filtering out pools whose apparent value is one one-off bribe."),
    },
  },
  withErrorHandling(async ({ veAero, address, topCandidates = 15, minConsistency = 0 }) => {
    const budget = await resolveVeAeroBudget(veAero, address);
    const ranked = (await rankPoolsByEfficiency()).filter((p) => p.consistency >= minConsistency);
    const allocation = recommendAllocation(ranked, budget, topCandidates);
    const totalExpectedUsd = allocation.reduce((a, b) => a + b.expectedUsd, 0);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              veAeroBudget: budget,
              budgetSource: address ? `live on-chain voting power of ${address}` : "caller-supplied amount",
              totalExpectedUsdNextEpoch: totalExpectedUsd,
              allocation,
              votePercents: toWholePercentWeights(allocation),
              note: "Weights and expected $ are a heuristic recommendation based on trailing-epoch trends and current vote snapshots, not a guarantee. `votePercents` are whole percentages summing to exactly 100, ready to enter in Aerodrome's voting UI. You sign and submit the vote yourself.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }),
);

server.registerTool(
  "backtest_strategy",
  {
    title: "Backtest the vote-allocation strategy against past epochs",
    description:
      "Replays recent completed epochs and compares what this tool's self-dilution-aware allocation would have earned against the naive 'put everything in the pool with the highest current $/vote' strategy. Each epoch's decision uses only data that existed before that epoch resolved, so it is not a hindsight fit. Caveats: it assumes your votes would not have changed other voters' behaviour, only sees pools whose gauge is still alive today (survivorship bias), and a handful of weekly epochs is a small sample.",
    inputSchema: {
      veAero: z.number().positive().finite().optional().describe("Amount of veAERO to simulate voting with. Omit this if you pass `address` instead."),
      address: z
        .string()
        .refine(isValidAddress, "Must be a 0x-prefixed 40-character hex address")
        .optional()
        .describe("Base wallet address to read live voting power from, instead of stating an amount."),
      epochs: z.number().int().positive().max(20).optional().describe(`How many past epochs to replay (default ${BACKTEST_EPOCHS})`),
    },
  },
  withErrorHandling(async ({ veAero, address, epochs = BACKTEST_EPOCHS }) => {
    const budget = await resolveVeAeroBudget(veAero, address);
    const report = await backtestLive(budget, epochs);

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  }),
);

server.registerTool(
  "get_my_veaero",
  {
    title: "Get an account's veAERO voting power",
    description: "Looks up all veAERO locks (NFTs) owned by a Base wallet address and their current voting power, via Aerodrome's VeSugar contract.",
    inputSchema: {
      address: z
        .string()
        .refine(isValidAddress, "Must be a 0x-prefixed 40-character hex address")
        .describe("Base wallet address (0x...)"),
    },
  },
  withErrorHandling(async ({ address }) => {
    const positions = await fetchVeAeroPositions(address);
    const totalVeAero = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);

    return {
      content: [{ type: "text", text: JSON.stringify({ address, totalVeAero, locks: positions }, null, 2) }],
    };
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("aero-vote-radar MCP server failed to start:", err);
  process.exit(1);
});
