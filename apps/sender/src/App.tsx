import { useState } from 'react';
import { useSession } from '@ctrl-arcz/demo-kit';
import { ConnectBar, SegmentedTabs, TopBar } from '@ctrl-arcz/demo-kit/ui';
import { SendTab } from './components/SendTab.js';
import { TransfersTab } from './components/TransfersTab.js';

type Tab = 'send' | 'transfers';

export function App() {
  const state = useSession();
  const [tab, setTab] = useState<Tab>('send');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'send', label: 'Send' },
    { id: 'transfers', label: 'Active' },
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
        </div>
      )}
    </main>
  );
}
