import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@ctrl-arcz/demo-kit';
import { ConnectBar, SegmentedTabs, TopBar, useT, useToast } from '@ctrl-arcz/demo-kit/ui';
import { PayTab } from './components/PayTab.js';
import { ActivityTab } from './components/ActivityTab.js';
import { BridgeTab } from './components/BridgeTab.js';
import { SubscriptionsTab } from './components/SubscriptionsTab.js';
import { ReceiveTab } from './components/ReceiveTab.js';
import { ModeSwitch, type Mode } from './components/ModeSwitch.js';
import { usePendingClaims } from './lib/usePendingClaims.js';

// Primary destinations, kept to a handful of real places. Bridge is a secondary
// utility reached from "More", not a peer of the core pay/track/subscribe loop.
type Tab = 'pay' | 'activity' | 'subscriptions' | 'bridge';

export function App() {
  const state = useSession();
  const t = useT();
  const toast = useToast();

  // A `?tid=` only points at which transfer to open. No part of the claim secret ever
  // travels in a URL: links leak into chat previews, history and Referer headers, and
  // the secret has to reach a person, not an address.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const linkTid = params.get('tid') ?? undefined;

  const [mode, setMode] = useState<Mode>(linkTid ? 'receive' : 'send');
  const [tab, setTab] = useState<Tab>('pay');

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

  // Three primary destinations; SegmentedTabs shows none highlighted while the
  // secondary Bridge view is open, which is the intended "you left the main tabs" cue.
  const primaryTabs: { id: Exclude<Tab, 'bridge'>; label: string }[] = [
    { id: 'pay', label: t('nav.pay') },
    { id: 'activity', label: t('nav.activity') },
    { id: 'subscriptions', label: t('nav.subscriptions') },
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
                <div className="tabrow">
                  <SegmentedTabs
                    tabs={primaryTabs}
                    value={tab === 'bridge' ? ('' as Exclude<Tab, 'bridge'>) : tab}
                    onChange={setTab}
                  />
                  <button
                    type="button"
                    className={['tab-more', tab === 'bridge' && 'is-active'].filter(Boolean).join(' ')}
                    aria-pressed={tab === 'bridge'}
                    onClick={() => setTab('bridge')}
                    data-testid="tab-bridge"
                  >
                    {t('nav.bridge')}
                  </button>
                </div>
                {tab === 'pay' && <PayTab session={state.session} onSent={state.refreshBalance} />}
                {tab === 'activity' && (
                  <ActivityTab session={state.session} onChange={state.refreshBalance} />
                )}
                {tab === 'subscriptions' && <SubscriptionsTab session={state.session} />}
                {tab === 'bridge' && <BridgeTab session={state.session} />}
              </>
            ) : (
              <ReceiveTab
                session={state.session}
                pending={pending}
                reload={reload}
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
