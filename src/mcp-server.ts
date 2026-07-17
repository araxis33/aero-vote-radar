#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rankPoolsByEfficiency } from "./efficiency.js";
import { recommendAllocation } from "./allocator.js";
import { fetchVeAeroPositions } from "./veAero.js";
import { isValidAddress } from "./util.js";

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
    },
  },
  async ({ top = 20 }) => {
    const ranked = await rankPoolsByEfficiency();
    const rows = ranked.slice(0, top).map((p) => ({
      pool: p.pool.address,
      symbol: p.pool.symbol,
      currentVotesVeAero: p.currentVotesVeAero,
      currentValuePerVoteUsd: p.currentValuePerVote,
      predictedValuePerVoteUsd: p.predictedValuePerVote,
      predictiveEdgePct: p.predictiveEdge * 100,
      epochsObserved: p.epochsObserved,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify({ poolsConsidered: ranked.length, top: rows }, null, 2) }],
    };
  },
);

server.registerTool(
  "recommend_allocation",
  {
    title: "Recommend a veAERO vote allocation",
    description:
      "Given a veAERO amount, recommends how to split votes across the current highest-efficiency Aerodrome pools using a greedy marginal-value ('water-filling') algorithm that accounts for self-dilution — voting more of your own veAERO into a pool measurably lowers your own $-per-vote there. Output is weights and expected USD only; this tool never touches a wallet, private key, or sends any transaction. The user reviews the recommendation and votes themselves on aerodrome.finance.",
    inputSchema: {
      veAero: z.number().positive().describe("Amount of veAERO voting power to allocate"),
      topCandidates: z.number().int().positive().max(50).optional().describe("How many top-ranked pools to consider as candidates (default 15)"),
    },
  },
  async ({ veAero, topCandidates = 15 }) => {
    const ranked = await rankPoolsByEfficiency();
    const allocation = recommendAllocation(ranked, veAero, topCandidates);
    const totalExpectedUsd = allocation.reduce((a, b) => a + b.expectedUsd, 0);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              veAeroBudget: veAero,
              totalExpectedUsdNextEpoch: totalExpectedUsd,
              allocation,
              note: "Weights and expected $ are a heuristic recommendation based on trailing-epoch trends and current vote snapshots, not a guarantee. You sign and submit the vote yourself.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
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
  async ({ address }) => {
    const positions = await fetchVeAeroPositions(address);
    const totalVeAero = positions.reduce((a, b) => a + b.votingPowerVeAero, 0);

    return {
      content: [{ type: "text", text: JSON.stringify({ address, totalVeAero, locks: positions }, null, 2) }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("aero-vote-radar MCP server failed to start:", err);
  process.exit(1);
});
