import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  arcTestnet,
  ARC_TESTNET_CHAIN_ID,
  RPC_URL,
  RPC_URLS,
  SIGNING_RPC_URLS,
  type ClientPair,
} from '@ctrl-arcz/sdk';

/**
 * The public Arc RPC returns JSON-RPC error -32011 "request limit reached" under
 * load, which viem does not retry (it is not a 5xx/timeout). Wrap each endpoint to
 * back off a few times on exactly that.
 */
function rlHttp(url: string): Transport {
  const inner = http(url, { retryCount: 2, retryDelay: 600, timeout: 20_000 });
  return ((params) => {
    const t = inner(params);
    const request = async (args: unknown, opts?: unknown) => {
      for (let i = 0; ; i++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          if (i < 3 && /request limit|rate limit|429|-32011/i.test(m)) {
            await new Promise((r) => setTimeout(r, 900));
            continue;
          }
          throw e; // let the fallback transport move to the next RPC
        }
      }
    };
    return { ...t, request } as typeof t;
  }) as Transport;
}

/** Spread requests across all public Arc RPCs; if one rate-limits, fall back to the
 *  next. This is what keeps heavy flows (deploy + fund + poll at once) alive. */
function arcTransport(): Transport {
  return fallback(
    RPC_URLS.map((u) => rlHttp(u)),
    { retryCount: 1 },
  );
}

/** The transport for anything that signs. See `SIGNING_RPC_URLS` for why the order
 *  differs from the read path. */
function arcSigningTransport(): Transport {
  return fallback(
    SIGNING_RPC_URLS.map((u) => rlHttp(u)),
    { retryCount: 1 },
  );
}

/**
 * The only things an injected wallet is actually needed for: proving who the user
 * is, and signing. Everything else is a plain chain read that any node can answer.
 */
const WALLET_ONLY = new Set([
  'eth_accounts',
  'eth_requestAccounts',
  'eth_chainId',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_decrypt',
  'eth_getEncryptionPublicKey',
]);

/**
 * Route reads to our own RPCs and leave the wallet to sign.
 *
 * MetaMask rate-limits a site by how many requests that site makes through
 * `window.ethereum`, and it answers with "Request is being rate limited." Viem
 * surfaces that as a *contract revert reason*, so a throttled send reads as
 * `The contract function "memo" reverted with the following reason: Request is
 * being rate limited` — a revert for a transaction that was never simulated,
 * naming a contract that is fine.
 *
 * Preparing one Arc transaction is not one request. Viem fills fees, nonce, gas
 * and — because Arc bills gas in USDC — `eth_fillTransaction` for the `feeToken`.
 * Pointed at the wallet, a single send spends most of a dozen requests of the
 * site's budget, and a two-step flow (approve, then send) doubles it. That is why
 * the failure lands on the last step, and sometimes on the second.
 *
 * None of those reads need the wallet. They are the same public chain reads the
 * app already makes through `arcTransport`, which spreads across four endpoints
 * and backs off on `-32011`. Only identity and signing stay on the wallet, so the
 * user still approves every transaction in MetaMask exactly as before, and the
 * site's request budget goes to the things that genuinely require it.
 *
 * `eth_chainId` deliberately stays on the wallet: it must report the chain the
 * *user* is on, not the one we would like them to be on, or the guard banner
 * would never fire on a wrong network.
 *
 * The reads go through `arcSigningTransport`, not the plain read one. This client
 * prepares transactions, so it asks `eth_fillTransaction`, and the read ordering
 * leads with the two endpoints that refuse that method.
 */
function injectedTransport(provider: EIP1193Provider): Transport {
  const reads = arcSigningTransport();
  return ((params) => {
    const wallet = custom(provider)(params);
    const rpc = reads(params);
    const request = async (args: unknown, opts?: unknown) => {
      const { method } = (args ?? {}) as { method?: string };
      const target =
        method && (WALLET_ONLY.has(method) || method.startsWith('wallet_')) ? wallet : rpc;
      return (target.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, opts);
    };
    return { ...wallet, request } as typeof wallet;
  }) as Transport;
}

export interface Session {
  address: Address;
  clients: ClientPair;
  chainId: number;
  /** True when the connected wallet is on Arc Testnet. */
  onArc: boolean;
}

const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: arcTransport(),
  pollingInterval: 6000, // ease receipt polling against the rate-limited public RPC
  // Coalesce concurrent readContract calls into a single Multicall3 RPC request.
  // readAccount fires 6 reads at once; batching turns them into ONE call, which
  // matters a lot against a rate-limited public RPC.
  batch: { multicall: { wait: 20 } },
});

export function getPublicClient(): PublicClient {
  return publicClient;
}

/**
 * A ClientPair backed by a raw private key. NOT for user wallets — used only for
 * a relayer/service signer (e.g. gasless-claim relay), where the key belongs to
 * the integrator's backend, not the end user.
 */
export function localSigner(privateKey: `0x${string}`): ClientPair {
  const account = privateKeyToAccount(privateKey);
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: arcSigningTransport(),
  });
  return { publicClient, walletClient };
}

function getProvider(): EIP1193Provider {
  const provider = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) {
    throw new Error('No wallet found. Install MetaMask or a compatible wallet.');
  }
  return provider;
}

export function hasWallet(): boolean {
  return Boolean((globalThis as { ethereum?: unknown }).ethereum);
}

/**
 * Connects the injected wallet (real EIP-1193).
 *
 * @param silent When true (a page-reload reconnect), uses `eth_accounts` — which
 *   never prompts — and returns null if the site is not already authorized. It
 *   also skips the "switch to Arc" prompt, letting the chain-guard banner handle
 *   a wrong network. When false (an explicit Connect click), it prompts via
 *   `eth_requestAccounts` and offers to switch to Arc.
 */
export async function injectedSession({ silent = false } = {}): Promise<Session | null> {
  const provider = getProvider();

  const accounts = (await provider.request({
    method: silent ? 'eth_accounts' : 'eth_requestAccounts',
  })) as Address[];
  const address = accounts[0];
  if (!address) {
    if (silent) return null; // not authorized yet — stay disconnected, no prompt
    throw new Error('No account selected.');
  }

  if (!silent) await ensureArcChain(provider);
  const chainId = await currentChainId(provider);

  const walletClient: WalletClient = createWalletClient({
    account: address,
    chain: arcTestnet,
    transport: injectedTransport(provider),
  });

  return {
    address,
    clients: { publicClient, walletClient },
    chainId,
    onArc: chainId === ARC_TESTNET_CHAIN_ID,
  };
}

async function currentChainId(provider: EIP1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * Asks the wallet to switch to Arc Testnet, adding the network if it is unknown.
 *
 * @param throwOnReject When false (the connect path), a user rejection (4001) is
 *   swallowed so the session still connects on the wrong chain and the guard
 *   banner can prompt them. When true (an explicit "switch" click), the rejection
 *   propagates so the caller can show feedback.
 */
export async function ensureArcChain(
  provider: EIP1193Provider,
  { throwOnReject = false }: { throwOnReject?: boolean } = {},
): Promise<void> {
  const hexId = `0x${arcTestnet.id.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexId,
            chainName: arcTestnet.name,
            nativeCurrency: arcTestnet.nativeCurrency,
            rpcUrls: [RPC_URL],
            blockExplorerUrls: [arcTestnet.blockExplorers?.default.url],
          },
        ],
      });
    } else if (code === 4001) {
      if (throwOnReject) throw err; // user rejected an explicit switch → surface it
    } else {
      throw err;
    }
  }
}

/** Asks the connected wallet to switch to Arc Testnet. Rejection propagates. */
export async function switchToArc(): Promise<void> {
  await ensureArcChain(getProvider(), { throwOnReject: true });
}

/** Subscribes to wallet account/chain changes. Returns an unsubscribe function. */
export function watchWallet(onChange: () => void): () => void {
  const provider = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider?.on) return () => {};
  const handler = () => onChange();
  provider.on('accountsChanged', handler);
  provider.on('chainChanged', handler);
  return () => {
    provider.removeListener?.('accountsChanged', handler);
    provider.removeListener?.('chainChanged', handler);
  };
}
