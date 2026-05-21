import { createWalletClient, http, type EIP1193Provider, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, RPC_URL } from '@ctrl-arcz/sdk';

export interface TestProviderOptions {
  /** Chain id the provider reports initially. Defaults to Arc Testnet. Set to a
   *  different id (e.g. 1) to exercise the wrong-network guard. */
  chainId?: number;
  /** When true, `wallet_switchEthereumChain` is rejected (user keeps the wrong
   *  network). When false (default) a switch moves the provider to Arc and emits
   *  `chainChanged`, so the "switch to Arc" flow can be tested too. */
  rejectSwitch?: boolean;
}

/**
 * A REAL EIP-1193 provider backed by a local private key, used ONLY in test mode
 * (never shipped to production). It lets the demo's genuine "Connect Wallet" flow
 * — the same code path that talks to MetaMask — be driven headlessly by the
 * browser-automation E2E tests: it signs locally and broadcasts to Arc, proxies
 * every read to the RPC, and can simulate a wrong network for the chain guard.
 *
 * Production builds never set VITE_DEMO_PK, so this is never installed there.
 */
export function makeTestProvider(
  privateKey: Hex,
  options: TestProviderOptions = {},
): EIP1193Provider {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });
  const rpc = http(RPC_URL)({ chain: arcTestnet });

  const arcHex = `0x${arcTestnet.id.toString(16)}`;
  let chainIdHex = options.chainId ? `0x${options.chainId.toString(16)}` : arcHex;

  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const emit = (event: string, ...args: unknown[]) =>
    (listeners[event] ?? []).forEach((h) => h(...args));

  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address];
        case 'eth_chainId':
          return chainIdHex;
        case 'net_version':
          return String(Number.parseInt(chainIdHex, 16));
        case 'wallet_switchEthereumChain': {
          if (options.rejectSwitch) {
            const err = new Error('User rejected the request.') as Error & { code: number };
            err.code = 4001;
            throw err;
          }
          chainIdHex = arcHex; // honour the switch → move to Arc
          emit('chainChanged', arcHex);
          return null;
        }
        case 'wallet_addEthereumChain':
        case 'wallet_watchAsset':
          return null;
        case 'eth_sendTransaction': {
          const tx = (params?.[0] ?? {}) as { to?: Hex; data?: Hex; value?: Hex; gas?: Hex };
          return wallet.sendTransaction({
            to: tx.to ?? null,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
            account,
            chain: arcTestnet,
          });
        }
        case 'eth_signTypedData_v4': {
          const raw = params?.[1];
          const typed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return wallet.signTypedData({
            account,
            domain: typed.domain,
            types: typed.types,
            primaryType: typed.primaryType,
            message: typed.message,
          });
        }
        case 'personal_sign':
          return wallet.signMessage({ account, message: { raw: params?.[0] as Hex } });
        default:
          return rpc.request({ method, params: params ?? [] } as never);
      }
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(handler);
      return provider;
    },
    removeListener(event: string, handler: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
      return provider;
    },
  };

  return provider as unknown as EIP1193Provider;
}

/** Installs the test provider on `window.ethereum` if no real wallet is present. */
export function installTestProvider(privateKey: Hex, options: TestProviderOptions = {}): void {
  const w = globalThis as { ethereum?: unknown };
  if (w.ethereum) return;
  w.ethereum = makeTestProvider(privateKey, options);
}
