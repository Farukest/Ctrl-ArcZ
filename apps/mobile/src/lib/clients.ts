import { createPublicClient, http, type PublicClient, type Transport } from 'viem';
import { arcTestnet, RPC_URL } from '@ctrl-arcz/sdk';

/**
 * The public Arc RPC returns JSON-RPC error -32011 "request limit reached" under
 * load, which viem does not retry. Wrap the transport to back off and retry on
 * exactly that, so a rate-limit blip does not break a flow. Mirrors the web
 * session transport in packages/demo-kit.
 */
function rlHttp(url: string): Transport {
  const inner = http(url, { retryCount: 6, retryDelay: 1200, timeout: 30_000 });
  return ((params) => {
    const t = inner(params);
    const request = async (args: unknown, opts?: unknown) => {
      for (let i = 0; ; i++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          if (i < 20 && /request limit|rate limit|429|-32011/i.test(m)) {
            await new Promise((r) => setTimeout(r, 1800));
            continue;
          }
          throw e;
        }
      }
    };
    return { ...t, request } as typeof t;
  }) as Transport;
}

/** Shared read client. Multicall batching collapses the SDK's several reads
 *  (readAccount, balances) into one RPC call, which matters against a rate-limited
 *  public RPC. */
export const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: rlHttp(RPC_URL),
  batch: { multicall: { wait: 20 } },
});

// The write/sign client comes from the connected external wallet (WalletConnect via
// wagmi's useWalletClient), not from a local key — see src/lib/wallet.tsx.
