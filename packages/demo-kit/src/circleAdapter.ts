import { createPublicClient, createWalletClient, fallback, http, type Chain } from 'viem';
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2';
import { arcTestnet, RPC_URLS } from '@ctrl-arcz/sdk';

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
  return chain.id === arcTestnet.id ? fallback(RPC_URLS.map((u) => http(u))) : http();
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
