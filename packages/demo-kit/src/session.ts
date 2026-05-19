import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, ARC_TESTNET_CHAIN_ID, RPC_URL, type ClientPair } from '@ctrl-arcz/sdk';

export interface Session {
  address: Address;
  clients: ClientPair;
  chainId: number;
  /** True when the connected wallet is on Arc Testnet. */
  onArc: boolean;
}

const publicClient: PublicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
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
    transport: http(RPC_URL),
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
    transport: custom(provider),
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
