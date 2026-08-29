import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useSession, isPlainClick, type ChainPurpose } from '@ctrl-arcz/demo-kit';
import { hrefFor, pushRoute, readRoute, type ActivityView } from './lib/route.js';
import {
  ConnectBar,
  IconHistory,
  ModeSwitch,
  NetworkMenu,
  NO_ARRIVALS,
  SegmentedTabs,
  SiteFooter,
  TopBar,
  nextArrival,
  useT,
  useToast,
  type Mode,
} from '@ctrl-arcz/demo-kit/ui';
import { useSettleDeposits } from './lib/activity.js';
import { PayTab } from './components/PayTab.js';
import { ActivityTab } from './components/ActivityTab.js';
import { BridgeTab } from './components/BridgeTab.js';
import { SubscriptionsTab } from './components/SubscriptionsTab.js';
import { ReceiveTab } from './components/ReceiveTab.js';
import { SourceLab } from './components/SourceLab.js';
import { usePendingClaims } from './lib/usePendingClaims.js';

// Primary destinations, kept to a handful of real places. Bridge is a secondary
// utility reached from "More", not a peer of the core pay/track/subscribe loop.
type Tab = 'pay' | 'activity' | 'subscriptions' | 'bridge';

/**
 * Which build this is, for the footer's bottom line.
 *
 * Both halves come from `vite.config.ts` at build time. The commit is the half
 * that gets used: it is how anyone, including whoever deployed it, can tell at a
 * glance whether the page in front of them is the one that was just pushed.
 */
function buildLabel(): string {
  const parts = [__APP_VERSION__ ? `v${__APP_VERSION__}` : '', __APP_COMMIT__].filter(Boolean);
  return parts.join(' · ');
}

export function App() {
  const state = useSession();
  const t = useT();
  const toast = useToast();

  // A `?tid=` only points at which transfer to open. No part of the claim secret ever
  // travels in a URL: links leak into chat previews, history and Referer headers, and
  // the secret has to reach a person, not an address.
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const linkTid = params.get('tid') ?? undefined;
  // A harness for UI that needs balances the live account cannot be made to hold.
  const lab = params.get('lab');

  const [mode, setMode] = useState<Mode>(linkTid ? 'receive' : 'send');
  /*
   * The tab is in the address, so it can be linked to, opened in a new tab and
   * gone back to. Read once for the first render and kept in step with the
   * browser's own history below.
   */
  const [tab, setTab] = useState<Tab>(() => readRoute(window.location.search).tab ?? 'pay');
  const [activityView, setActivityView] = useState(
    () => readRoute(window.location.search).view,
  );

  /*
   * A tab switch is a transition, not an urgent update. Mounting a tab is a heavy
   * synchronous render -- the bridge alone is a large tree that also kicks off its
   * reads -- and as an urgent update it blocked the main thread on every click, so
   * flicking between tabs quickly stacked those blocking renders back to back and
   * the UI froze. As a transition React renders the next tab off the urgent path,
   * keeps the current one on screen and interactive, and abandons a half-done
   * render the instant another tab is picked, so only the tab you land on is ever
   * fully rendered. This is how a router keeps navigation responsive.
   */
  const [, startTabSwitch] = useTransition();
  const selectTab = (next: Tab, view?: ActivityView) => {
    pushRoute(next, view);
    startTabSwitch(() => {
      setTab(next);
      setActivityView(view);
    });
  };

  /*
   * The back and forward arrows. Without this the address changes and the screen
   * does not, which is worse than having no addresses at all: the URL would be
   * telling the truth about somewhere the reader is not.
   */
  useEffect(() => {
    const onPop = () => {
      const r = readRoute(window.location.search);
      startTabSwitch(() => {
        setTab(r.tab ?? 'pay');
        setActivityView(r.view);
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const { pending, claimable, reload } = usePendingClaims(state.session);
  const pendingCount = claimable?.length ?? 0;

  // Announce an arriving payment wherever the user is standing.
  //
  // This used to fire only on the Send side, on the reasoning that the Receive
  // side shows it anyway. It does not, in the way that matters: the list is
  // searched, filtered and paged, so a new row can land off-screen, and the
  // person most likely to be sitting on the Receive tab is exactly the one
  // waiting to be told. What it says differs by side, though: telling someone
  // already looking at the Receive screen to go to the Receive screen reads as a
  // message written for somebody else.
  //
  // When it fires and when it stays quiet is `nextArrival`, tested on its own.
  const arrival = useRef(NO_ARRIVALS);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const step = nextArrival(arrival.current, claimable);
    arrival.current = step.state;
    if (step.announce) {
      toast.push(
        modeRef.current === 'receive' ? t('receive.newIncomingHere') : t('receive.newIncoming'),
        'success',
      );
    }
  }, [claimable, toast, t]);

  // A different wallet has a different inbox, so the next poll is a first poll.
  useEffect(() => {
    arrival.current = NO_ARRIVALS;
  }, [state.session?.address]);

  /*
   * The three things you come here to do, and then the record of having done them.
   *
   * Bridge used to be the odd one out, parked on the right as a secondary
   * destination while Activity sat in the row. That had it backwards: moving money
   * across chains is a thing you do, in the same breath as paying and subscribing,
   * and Activity is where you go afterwards to check. So Bridge joins the row and
   * Activity takes the place beside it, with an icon, because a history is a
   * different kind of destination from an action and should not look like a fourth
   * one. SegmentedTabs shows none highlighted while Activity is open, which is the
   * intended "you left the main tabs" cue.
   */
  /*
   * The last step of a deposit, finished wherever the reader happens to be.
   *
   * It used to run inside the balance poll of the screen with the deposit box on
   * it, so a deposit made and then left on another tab never completed: measured
   * on a real one, five minutes on "Counted by Circle" and four seconds after
   * coming back. Mounted once here, it costs nothing when there is nothing
   * pending, and being the only settler is what stops two of them crediting the
   * same rise in the balance.
   */
  useSettleDeposits(state.session?.address);

  /**
   * Which networks the header chip offers, which is a question about this page.
   *
   * Switching the wallet from the header used to be able to land anywhere in
   * Circle's twenty testnets, and on fifteen of them the tab underneath turned
   * into "not available on this network". The chip still says where the wallet is,
   * whatever chain that is; what it offers is where the thing you are looking at
   * can be done.
   *
   * Bridge asks for the CCTP list rather than the Gateway one because the tab
   * holds both engines and CCTP is the wider of the two, so narrowing to Gateway's
   * eleven would refuse nine chains that bridge perfectly well. Activity acts on
   * nothing, so it offers the same wide list: it is where you land after a bridge.
   */
  const headerPurpose: ChainPurpose =
    mode === 'receive'
      ? 'receive'
      : tab === 'pay'
        ? 'protectedSend'
        : tab === 'subscriptions'
          ? 'subscriptions'
          : 'cctpSource';

  const primaryTabs: { id: Exclude<Tab, 'activity'>; label: string }[] = [
    { id: 'pay', label: t('nav.pay') },
    { id: 'bridge', label: t('nav.bridge') },
    { id: 'subscriptions', label: t('nav.subscriptions') },
  ];

  if (lab === 'sources') {
    return (
      <main className="app-shell">
        <TopBar actions={<NetworkMenu state={state} purpose={headerPurpose} />} />
        <SourceLab />
      </main>
    );
  }

  return (
    <>
      <main className="app-shell">
        <TopBar actions={<NetworkMenu state={state} purpose={headerPurpose} />} />
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
                      value={tab === 'activity' ? ('' as Exclude<Tab, 'activity'>) : tab}
                      onChange={selectTab}
                    />
                    {/* A link, not a button, so it can be middle-clicked into a
                        new tab and copied like any other address. The plain click
                        is still handled here and never reloads the page. */}
                    <a
                      className={['tab-more', tab === 'activity' && 'is-active']
                        .filter(Boolean)
                        .join(' ')}
                      href={hrefFor('activity')}
                      aria-current={tab === 'activity' ? 'page' : undefined}
                      onClick={(e) => {
                        if (!isPlainClick(e)) return;
                        e.preventDefault();
                        selectTab('activity');
                      }}
                      data-testid="tab-activity"
                    >
                      <IconHistory width={16} height={16} aria-hidden />
                      {t('nav.activity')}
                    </a>
                  </div>
                  {tab === 'pay' && (
                    <PayTab
                      session={state.session}
                      balance={state.balanceRaw}
                      balanceMissing={state.balanceMissing}
                      onSent={state.refreshBalance}
                      onSwitchChain={state.switchTo}
                    />
                  )}
                  {tab === 'activity' && (
                    <ActivityTab
                      session={state.session}
                      onChange={state.refreshBalance}
                      {...(activityView ? { initialView: activityView } : {})}
                    />
                  )}
                  {tab === 'subscriptions' && (
                    <SubscriptionsTab
                      session={state.session}
                      onSwitchChain={state.switchTo}
                      onOpenActivity={(v) => selectTab('activity', v)}
                    />
                  )}
                  {tab === 'bridge' && (
                    <BridgeTab
                      session={state.session}
                      onOpenActivity={(v) => selectTab('activity', v)}
                    />
                  )}
                </>
              ) : (
                <ReceiveTab
                  session={state.session}
                  pending={pending}
                  reload={reload}
                  balance={state.balance}
                  onClaimed={state.refreshBalance}
                  onSwitchChain={state.switchTo}
                />
              )}
            </div>
          </>
        )}
      </main>

      {/* Outside the shell as well as outside the session guard. Outside the guard
          because someone who has not connected a wallet yet is exactly who the
          links are written for; outside the shell so the band can run the width of
          the window instead of being one more card in the column. */}
      <SiteFooter version={buildLabel()} />
    </>
  );
}
