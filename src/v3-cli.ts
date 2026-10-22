#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { client } from "./chain.js";
import { V3_LOGS_RPC_URL } from "./constants.js";
import { getTokenPrices } from "./prices.js";
import { formatError } from "./util.js";
import { registryFromDeployment, scanV3, type V3ScanFile, type V3Client } from "./v3.js";

/**
 * Entrypoint for the scheduled Aero (v3) scan on Base. It prefers Aero's own
 * deployment file: scripts/aero-chains.mjs records which file in
 * dromos-labs/metadex-public belongs to Base. Until that file exists it uses
 * the Base FactoryRegistry Aero published at app.aero.xyz/docs/security on
 * 2026-10-21. Nothing on the page reads the output yet. `V3_REGISTRY`
 * overrides the registry for a manual check.
 */
const RAW = "https://raw.githubusercontent.com/dromos-labs/metadex-public/main/deployment-addresses/";
const BASE_REGISTRY = "0x7b2A2c12dC5Ea2a31455952a05031C3E4BB28F3E";
// The new AERO (app.aero.xyz/docs/security) has no DefiLlama price yet on launch
// day; it upgrades 1:1 from the old AERO, so it is priced as the old one.
const NEW_AERO = "0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee";
const OLD_AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";

async function registryAddress(): Promise<string | undefined> {
  if (process.env.V3_REGISTRY) return process.env.V3_REGISTRY;
  let file: string | undefined;
  try {
    file = JSON.parse(readFileSync("docs/data/aero-chains.json", "utf8")).chains?.base?.file;
  } catch {
    return BASE_REGISTRY;
  }
  if (!file) return BASE_REGISTRY;
  const res = await fetch(RAW + file, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${file} ${res.status}`);
  return registryFromDeployment((await res.json()) as Record<string, unknown>);
}

async function main() {
  const outPath = process.argv[2] ?? "docs/data/v3.json";
  const now = new Date();
  const registry = await registryAddress();
  let out: V3ScanFile;
  if (!registry) {
    out = { checkedAt: now.toISOString(), chain: "base", status: "no-addresses", windowHours: 0, gauges: [] };
  } else {
    const c = client as unknown as V3Client & { getBlockNumber(): Promise<bigint> };
    const logs = createPublicClient({ chain: base, transport: http(V3_LOGS_RPC_URL, { retryCount: 6, retryDelay: 1500 }) });
    out = await scanV3({ readContract: c.readContract, getBlockNumber: c.getBlockNumber, getLogs: logs.getLogs as unknown as V3Client["getLogs"] }, registry as `0x${string}`, {
      chain: "base",
      now,
      priceOf: async (tokens) => {
        const prices = await getTokenPrices([...tokens, OLD_AERO]);
        return (t) => {
          const p = prices.get((t.toLowerCase() === NEW_AERO ? OLD_AERO : t).toLowerCase());
          return p && p.price > 0 ? { decimals: p.decimals, priceUsd: p.price } : undefined;
        };
      },
    });
  }
  writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
  console.error(`v3: ${out.status}, ${out.gauges.length} gauges, ${out.windowHours.toFixed(1)} h of fees -> ${outPath}`);
}

main().catch((err) => {
  console.error(`Error: ${formatError(err)}`);
  process.exitCode = 1;
});
