import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Chain,
  type Transport,
} from 'viem';
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2';
import { arcTestnet, RPC_URLS } from '@ctrl-arcz/sdk';

/**
 * Answer the wallet-namespace methods locally instead of asking a node.
 *
 * Circle's kits call `ensureChain` before they move money, which ends in
 * `wallet_switchEthereumChain`. That is a question for a wallet, not for a node,
 * and every Arc endpoint rightly refuses it: drpc with -32601, blockdaemon with
 * 403 "Request method filtered". The refusal surfaced as `Bridge failed.
 * Approving USDC...: Failed to switch to chain Arc Testnet` -- a chain error for
 * something that was never a chain problem, on a signer whose chain is fixed at
 * construction and cannot be switched at all.
 *
 * A request to switch to the chain this signer is already pinned to is already
 * satisfied, so it returns null. A request to switch anywhere else throws, loudly:
 * answering it would tell the caller it is on Base while the signer still signs
 * for Arc, and the next transaction would go out on the wrong chain.
 */
function walletAware(inner: Transport, chain: Chain): Transport {
  return ((params: Parameters<Transport>[0]) => {
    const t = inner(params);
    const pinned = `0x${chain.id.toString(16)}`.toLowerCase();
    const request = async (args: unknown, opts?: unknown) => {
      const { method, params: rpcParams } = (args ?? {}) as {
        method?: string;
        params?: Array<{ chainId?: string }>;
      };
      if (method === 'wallet_switchEthereumChain') {
        const asked = rpcParams?.[0]?.chainId;
        if (typeof asked === 'string' && asked.toLowerCase() !== pinned) {
          throw new Error(
            `Refusing to switch to ${asked}: this signer is pinned to ${chain.name} (${pinned}).`,
          );
        }
        return null;
      }
      if (method === 'wallet_addEthereumChain' || method === 'wallet_watchAsset') return null;
      return (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
    };
    return { ...t, request } as typeof t;
  }) as Transport;
}

/**
 * Server-only. The signing adapter Circle's kits use, pointed at RPCs we trust.
 *
 * Left to itself the adapter dials one default endpoint per chain, and on Arc that
 * is the public one, which rate-limits under any real load. A bridge then fails at
 * its very first step with "Network connection failed for Arc Testnet" and no
 * indication that the money and the code were both fine. Arc goes through the same
 * ranked fallback list the rest of the app uses; every other chain keeps the
 * adapter's own default.
 */
function transportFor(chain: Chain) {
  const rpc = chain.id === arcTestnet.id ? fallback(RPC_URLS.map((u) => http(u))) : http();
  return walletAware(rpc, chain);
}

// The adapter's own return type names types the package does not re-export, which
// `tsc --noEmit` rejects on an exported function (TS4058). Borrowing the factory's
// return type keeps the annotation exact without importing anything unnameable.
export function circleAdapter(
  privateKey: `0x${string}`,
): ReturnType<typeof createViemAdapterFromPrivateKey> {
  return createViemAdapterFromPrivateKey({
    privateKey,
    getPublicClient: ({ chain }) => createPublicClient({ chain, transport: transportFor(chain) }),
    getWalletClient: ({ chain, account }) =>
      createWalletClient({ account, chain, transport: transportFor(chain) }),
  });
}
