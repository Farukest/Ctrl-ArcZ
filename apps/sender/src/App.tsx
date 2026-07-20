import { useEffect, useMemo, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { useSession } from '@ctrl-arcz/demo-kit';
import { ConnectBar, SegmentedTabs, TopBar, useT, useToast } from '@ctrl-arcz/demo-kit/ui';
import { SendTab } from './components/SendTab.js';
import { TransfersTab } from './components/TransfersTab.js';
import { HistoryTab } from './components/HistoryTab.js';
import { BridgeTab } from './components/BridgeTab.js';
import { PrivatePayTab } from './components/PrivatePayTab.js';
import { ReceiveTab } from './components/ReceiveTab.js';
import { ModeSwitch, type Mode } from './components/ModeSwitch.js';
import { usePendingClaims } from './lib/usePendingClaims.js';

type Tab = 'send' | 'transfers' | 'history' | 'bridge' | 'privatepay';

export function App() {
  const state = useSession();
  const t = useT();
  const toast = useToast();

  // Claim links carry only the non-secret tid + salt. If present, open in Receive.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const linkTid = params.get('tid') ?? undefined;
  const linkSalt = (params.get('salt') as Hex | null) ?? null;

  const [mode, setMode] = useState<Mode>(linkTid || linkSalt ? 'receive' : 'send');
  const [tab, setTab] = useState<Tab>('send');

  const { pending, reload } = usePendingClaims(state.session);
  const pendingCount = pending?.length ?? 0;

  // Notify when a protected payment arrives while the user is on the Send side, so
  // they can switch over and claim it — the "someone paid you" moment, in one app.
  const prevCount = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount > prevCount.current && mode === 'send') {
      toast.push(t('receive.newIncoming'), 'success');
    }
    prevCount.current = pendingCount;
  }, [pendingCount, mode, toast, t]);

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
      <p className="subtitle">{t('app.subtitle')}</p>

      <ConnectBar state={state} />

      {state.session && (
        <>
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <ModeSwitch mode={mode} onChange={setMode} pendingCount={pendingCount} />
          </div>

          {/* Keyed so switching replays the enter transition (see .mode-view). */}
          <div className="mode-view" data-mode={mode} key={mode}>
            {mode === 'send' ? (
              <>
                <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} />
                {tab === 'send' && <SendTab session={state.session} onSent={state.refreshBalance} />}
                {tab === 'transfers' && (
                  <TransfersTab session={state.session} onChange={state.refreshBalance} />
                )}
                {tab === 'history' && <HistoryTab session={state.session} />}
                {tab === 'bridge' && <BridgeTab />}
                {tab === 'privatepay' && <PrivatePayTab session={state.session} />}
              </>
            ) : (
              <ReceiveTab
                session={state.session}
                pending={pending}
                reload={reload}
                salt={linkSalt}
                initialTid={linkTid ?? ''}
                balance={state.balance}
                onClaimed={state.refreshBalance}
              />
            )}
          </div>
        </>
      )}
    </main>
  );
}
