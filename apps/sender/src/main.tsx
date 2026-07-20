import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestProvider } from '@ctrl-arcz/demo-kit';
import { I18nProvider, ThemeProvider, ToastProvider } from '@ctrl-arcz/demo-kit/ui';
import { App } from './App.js';
import './app.css';

// Test mode only: install a local-key EIP-1193 provider so the real "Connect
// Wallet" flow can be driven headlessly. Never runs in production (no VITE_DEMO_PK).
// URL params exercise the chain guard: ?wrongchain=1 reports a non-Arc network,
// &rejectswitch=1 makes the wallet refuse to switch.
const demoPk = import.meta.env.VITE_DEMO_PK as `0x${string}` | undefined;
if (demoPk) {
  const q = new URLSearchParams(window.location.search);
  installTestProvider(demoPk, {
    ...(q.get('wrongchain') ? { chainId: 1 } : {}),
    ...(q.get('rejectswitch') ? { rejectSwitch: true } : {}),
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
