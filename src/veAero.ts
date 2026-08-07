import { client } from "./chain.js";
import { VE_SUGAR_ABI } from "./abi.js";
import { VE_SUGAR_ADDRESS } from "./constants.js";
import { normalizeAddress } from "./util.js";

const VE_DECIMALS = 18;

export interface VeNftSummary {
  // string, not bigint/number: NFT IDs must round-trip through JSON (the MCP
  // tool responses are JSON) without precision loss or "cannot serialize BigInt" errors.
  id: string;
  votingPowerVeAero: number;
  expiresAt: number;
}

interface VeNftRaw {
  id: bigint;
  voting_amount: bigint;
  expires_at: bigint;
}

/**
 * Turns one raw VeSugar NFT struct into its summary shape. Pure, so it's
 * unit-testable without mocking RPC calls — unlike `fetchVeAeroPositions`,
 * which fetches live.
 */
export function toVeNftSummary(nft: VeNftRaw): VeNftSummary {
  return {
    id: nft.id.toString(),
    votingPowerVeAero: Number(nft.voting_amount) / 10 ** VE_DECIMALS,
    expiresAt: Number(nft.expires_at),
  };
}

/**
 * Looks up all veAERO NFTs (locks) owned by an account and their current voting power.
 * Normalizes `account` to its EIP-55 checksum first: viem's contract calls require a
 * mixed-case address to exactly match its checksum, so a caller-supplied address typed
 * or pasted in a different (but still well-formed) case would otherwise crash here with
 * a raw "Address ... is invalid" error instead of returning a result.
 */
export async function fetchVeAeroPositions(account: string): Promise<VeNftSummary[]> {
  const nfts = await client.readContract({
    address: VE_SUGAR_ADDRESS,
    abi: VE_SUGAR_ABI,
    functionName: "byAccount",
    args: [normalizeAddress(account)],
  });

  return nfts.map(toVeNftSummary);
}
