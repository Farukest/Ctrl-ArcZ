import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestProvider } from '@ctrl-arcz/demo-kit';
import { I18nProvider, ThemeProvider, ToastProvider } from '@ctrl-arcz/demo-kit/ui';
import { App } from './App.js';

const demoPk = import.meta.env.VITE_DEMO_PK as `0x${string}` | undefined;
if (demoPk) installTestProvider(demoPk);

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
