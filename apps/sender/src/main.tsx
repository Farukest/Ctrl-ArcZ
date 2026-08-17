import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestProvider } from '@ctrl-arcz/demo-kit';
import { I18nProvider, ThemeProvider, ToastProvider } from '@ctrl-arcz/demo-kit/ui';
import { App } from './App.js';
import './app.css';

// Test mode only: install a local-key EIP-1193 provider so the real "Connect
// Wallet" flow can be driven headlessly. Never runs in production (no VITE_DEMO_PK).
// URL params exercise the chain guard: ?wrongchain=1 reports a non-Arc network,
// ?chain=<id> reports that particular one, &rejectswitch=1 makes the wallet refuse
// to switch.
//
// `chain` exists because `wrongchain` only produces Ethereum mainnet, a chain with
// no entry in any of our tables. That covers the "we have never heard of this
// network" branch and nothing else -- and the interesting cases are the chains we
// do know, where every control on the screen is supposed to follow the wallet onto
// them. "The wallet is on Base Sepolia" was a state no test could reach.
const demoPk = import.meta.env.VITE_DEMO_PK as `0x${string}` | undefined;
if (demoPk) {
  const q = new URLSearchParams(window.location.search);
  const asked = Number(q.get('chain'));
  installTestProvider(demoPk, {
    ...(Number.isInteger(asked) && asked > 0 ? { chainId: asked } : {}),
    ...(q.get('wrongchain') ? { chainId: 1 } : {}),
    ...(q.get('rejectswitch') ? { rejectSwitch: true } : {}),
    // ?testwallet=1 takes over from an installed extension, so the app can be driven
    // in a real browser that happens to have MetaMask in it.
    ...(q.get('testwallet') ? { force: true } : {}),
  });
}

// Dev only: the UI audit on `window.__uiAudit`, so a browser session can measure a
// screen (selected-state contrast, theme reach, target sizes, chip alignment) rather
// than describe it. Tree-shaken out of the production bundle by the constant check.
if (import.meta.env.DEV) {
  void import('./audit/uiAudit.js').then((m) => {
    (window as unknown as { __uiAudit: typeof m }).__uiAudit = m;
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
