import { useState } from 'react';
import { useSession } from '@ctrl-arcz/demo-kit';
import { ConnectBar, SegmentedTabs, TopBar } from '@ctrl-arcz/demo-kit/ui';
import { SendTab } from './components/SendTab.js';
import { TransfersTab } from './components/TransfersTab.js';
import { HistoryTab } from './components/HistoryTab.js';
import { DemoTab } from './components/DemoTab.js';

type Tab = 'send' | 'transfers' | 'history' | 'demo';

export function App() {
  const state = useSession();
  const [tab, setTab] = useState<Tab>('send');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'send', label: 'Send' },
    { id: 'transfers', label: 'Active' },
    { id: 'history', label: 'History' },
    { id: 'demo', label: 'Poisoning' },
  ];

  return (
    <main className="app-shell">
      <TopBar />
      <p className="subtitle">Protected USDC transfers on Arc.</p>

      <ConnectBar state={state} />

      {state.session && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} />

          {tab === 'send' && <SendTab session={state.session} onSent={state.refreshBalance} />}
          {tab === 'transfers' && (
            <TransfersTab session={state.session} onChange={state.refreshBalance} />
          )}
          {tab === 'history' && <HistoryTab session={state.session} />}
          {tab === 'demo' && <DemoTab session={state.session} />}
        </div>
      )}
    </main>
  );
}
