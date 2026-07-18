import { useState } from 'react';
import { useSession } from '@ctrl-arcz/demo-kit';
import { ConnectBar, SegmentedTabs, TopBar, useT } from '@ctrl-arcz/demo-kit/ui';
import { SendTab } from './components/SendTab.js';
import { TransfersTab } from './components/TransfersTab.js';
import { HistoryTab } from './components/HistoryTab.js';
import { BridgeTab } from './components/BridgeTab.js';
import { PrivatePayTab } from './components/PrivatePayTab.js';

type Tab = 'send' | 'transfers' | 'history' | 'bridge' | 'privatepay';

export function App() {
  const state = useSession();
  const t = useT();
  const [tab, setTab] = useState<Tab>('send');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'send', label: t('nav.send') },
    { id: 'transfers', label: t('nav.active') },
    { id: 'history', label: t('nav.history') },
    { id: 'bridge', label: t('nav.bridge') },
    { id: 'privatepay', label: t('nav.privatepay') },
  ];

  return (
    <main className="app-shell">
      <TopBar />
      <p className="subtitle">{t('sender.subtitle')}</p>

      <ConnectBar state={state} />

      {state.session && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} />

          {tab === 'send' && <SendTab session={state.session} onSent={state.refreshBalance} />}
          {tab === 'transfers' && (
            <TransfersTab session={state.session} onChange={state.refreshBalance} />
          )}
          {tab === 'history' && <HistoryTab session={state.session} />}
          {tab === 'bridge' && <BridgeTab />}
          {tab === 'privatepay' && <PrivatePayTab session={state.session} />}
        </div>
      )}
    </main>
  );
}
