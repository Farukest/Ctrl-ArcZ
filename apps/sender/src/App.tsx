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

  // Announce an arriving payment wherever the user is standing.
  //
  // This used to fire only on the Send side, on the reasoning that the Receive
  // side shows it anyway. It does not, in the way that matters: the list is
  // searched, filtered and paged, so a new row can land off-screen, and the
  // person most likely to be sitting on the Receive tab is exactly the one
  // waiting to be told.
  //
  // `seeded` keeps the first successful poll quiet. Without it, opening the app
  // with transfers already waiting announces them as if they had just arrived.
  const seeded = useRef(false);
  const prevCount = useRef(0);
  useEffect(() => {
    if (pending === null) return; // still loading; nothing to compare against
    const count = pending.length;
    if (!seeded.current) {
      seeded.current = true;
      prevCount.current = count;
      return;
    }
    if (count > prevCount.current) toast.push(t('receive.newIncoming'), 'success');
    prevCount.current = count;
  }, [pending, toast, t]);

  // A different wallet has a different inbox, so the next poll is a first poll.
  useEffect(() => {
    seeded.current = false;
    prevCount.current = 0;
  }, [state.session?.address]);

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
