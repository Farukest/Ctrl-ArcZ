import '@walletconnect/react-native-compat';
import { arcTestnet } from '@ctrl-arcz/sdk';
import {
  createAppKit,
  defaultWagmiConfig,
  type AppKitOptions,
} from '@reown/appkit-wagmi-react-native';

/**
 * WalletConnect / Reown AppKit wiring — the mobile app connects the user's OWN
 * wallet (MetaMask, Rabby, Trust, ...) instead of holding a key. AppKit renders the
 * wallet-picker modal and deep-links to the chosen wallet; signing happens there.
 *
 * The project id is a public identifier (not a secret) from https://cloud.reown.com.
 * Set EXPO_PUBLIC_WC_PROJECT_ID in the app's env; without it the picker cannot reach
 * the WalletConnect relay, so connecting is a no-op until it is provided.
 */
export const WC_PROJECT_ID = process.env.EXPO_PUBLIC_WC_PROJECT_ID ?? '';

const metadata = {
  name: 'Ctrl+ArcZ',
  description: 'Protected USDC transfers and payer-side privacy on Arc',
  url: 'https://ctrlarcz.xyz',
  icons: ['https://ctrlarcz.xyz/favicon.png'],
  redirect: {
    native: 'ctrlarcz://',
    universal: 'https://ctrlarcz.xyz',
  },
};

export const wagmiConfig = defaultWagmiConfig({
  chains: [arcTestnet],
  projectId: WC_PROJECT_ID,
  metadata,
});

// defaultWagmiConfig + createAppKit are the documented pairing from this same
// package; the only type friction is our viem Chain version making the Config
// generic non-identical, so assert the options shape (runtime is correct).
createAppKit({
  projectId: WC_PROJECT_ID,
  wagmiConfig,
  defaultChain: arcTestnet,
} as unknown as AppKitOptions);
