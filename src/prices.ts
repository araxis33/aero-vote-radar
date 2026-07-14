import { DEFILLAMA_PRICE_URL } from "./constants.js";

type DefiLlamaResponse = {
  coins: Record<string, { price: number; decimals: number; symbol: string }>;
};

export interface TokenPrice {
  price: number;
  decimals: number;
}

const cache = new Map<string, TokenPrice>();

/**
 * Looks up current USD price + decimals for a batch of Base token addresses via
 * DefiLlama's free, keyless price API. Missing/unpriced tokens (obscure or very
 * new bribe tokens are common) get price 0 rather than throwing, so one unpriced
 * token doesn't blow up a whole pool's calculation — it just contributes $0.
 */
export async function getTokenPrices(
  tokenAddresses: string[],
): Promise<Map<string, TokenPrice>> {
  const unique = [...new Set(tokenAddresses.map((a) => a.toLowerCase()))];
  const uncached = unique.filter((a) => !cache.has(a));

  if (uncached.length > 0) {
    const keys = uncached.map((a) => `base:${a}`).join(",");
    const res = await fetch(`${DEFILLAMA_PRICE_URL}/${keys}`);
    if (res.ok) {
      const data = (await res.json()) as DefiLlamaResponse;
      for (const [key, coin] of Object.entries(data.coins)) {
        const address = key.split(":")[1]?.toLowerCase();
        if (address) cache.set(address, { price: coin.price, decimals: coin.decimals });
      }
    }
    for (const a of uncached) {
      if (!cache.has(a)) cache.set(a, { price: 0, decimals: 18 });
    }
  }

  const result = new Map<string, TokenPrice>();
  for (const a of unique) result.set(a, cache.get(a) ?? { price: 0, decimals: 18 });
  return result;
}

/** Converts a raw on-chain token amount to a USD value using a looked-up price/decimals map. */
export function toUsd(amount: bigint, token: string, prices: Map<string, TokenPrice>): number {
  const info = prices.get(token.toLowerCase());
  if (!info || info.price === 0) return 0;
  return (Number(amount) / 10 ** info.decimals) * info.price;
}
