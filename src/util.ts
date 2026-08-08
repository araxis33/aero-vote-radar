import { getAddress } from "viem";

/** Runs `fn` over `items` with at most `concurrency` in flight at once, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Validates that a string looks like an EVM address: `0x` followed by exactly 40 hex characters. */
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Normalizes a syntactically valid address (any letter case) to its canonical
 * EIP-55 checksum casing. viem's own contract calls validate that a mixed-case
 * address matches its checksum and throw a raw "Address ... is invalid" error
 * otherwise — so an address that merely *looks* valid per `isValidAddress`
 * (e.g. typed or pasted in all-uppercase, or any case that isn't the exact
 * checksum) would pass this project's own validation and then crash deep
 * inside viem instead of returning a clean result. Callers should validate with
 * `isValidAddress` first (this assumes that already holds) and normalize with
 * this before the address reaches any on-chain call.
 */
export function normalizeAddress(address: string): `0x${string}` {
  return getAddress(address);
}

/**
 * Reduces a thrown value to a single-line message, for both CLI error output
 * and MCP tool error results. viem errors (the common case here — a failed
 * RPC call) carry a concise `.shortMessage` but their `.message` is a
 * multi-paragraph dump of docs links, metaMessages, and version info;
 * surfacing that (or the raw Error, stack trace and all) buries the actual
 * problem in noise.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const shortMessage = (err as { shortMessage?: unknown }).shortMessage;
    return typeof shortMessage === "string" ? shortMessage : err.message;
  }
  return String(err);
}

/**
 * Wraps a failure from `VeSugar.byAccount` with a hint about its one known
 * failure mode: that call returns one large struct per veAERO lock — including
 * every vote that lock has cast — and reliably reverts outright on a public RPC
 * once an account holds enough locks (a 22-lock wallet already reverts; see the
 * web app's `docs/index.html`, which works around it with plain VotingEscrow
 * calls instead). Without this, a wallet that hits this fails with a bare
 * "reverted" message that gives no indication of why or what to do about it.
 */
export function describeVeAeroLookupFailure(err: unknown): string {
  return `${formatError(err)} (this can happen for wallets holding many veAERO locks, where VeSugar.byAccount reverts on a public RPC — try setting BASE_RPC_URL to a private RPC with a higher gas allowance, or look the address up at the web app instead)`;
}
