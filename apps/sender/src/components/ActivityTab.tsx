import { useEffect, useMemo, useState } from 'react';
import { cancel, TransferUnavailableError } from '@ctrl-arcz/sdk';
import { useActivityFeed, type ActivityEntry, type Session } from '@ctrl-arcz/demo-kit';
import {
  ActivityScreen,
  Card,
  SegmentedTabs,
  useSubmitGuard,
  useT,
  useToast,
} from '@ctrl-arcz/demo-kit/ui';
import { useActivity } from '../lib/activity.js';
import {
  bridgeEntries,
  historyEntries,
  isSubscriptionRun,
  sentEntries,
} from '../lib/activityEntries.js';
import { useSentTransfers, useTokenHistory } from '../lib/useActivityData.js';
import { knownBoxes } from '../lib/useSubscriptions.js';

/**
 * Everything this wallet has done, in one place, read four ways.
 *
 * It used to be two screens behind a toggle, each with its own list, its own
 * search, its own idea of a row, and no way to reach the bridge history at all
 * without going to the bridge screen. The four views are four sets of rows now,
 * over one screen: the same search, the same chips, the same dates, the same
 * pager, the same row.
 *
 * The rows themselves are built in `activityEntries`, which is the only file that
 * knows what any of these records are. This one decides which set is on screen
 * and what its chips are called.
 */

type View = 'sent' | 'history' | 'bridge' | 'subs';

const PAGE_SIZE = 8;

export function ActivityTab({ session, onChange }: { session: Session; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const guard = useSubmitGuard();
  const [view, setView] = useState<View>('sent');
  const [busy, setBusy] = useState<string | null>(null);

  const sent = useSentTransfers(session);
  const chainHistory = useTokenHistory(session);
  const runs = useActivity();

  /*
   * Which runs paid for a subscription, told from the recipient rather than a
   * flag: the box address is already on the record and the set of boxes is
   * already known, so there is nothing to store and no way for a flag to
   * disagree with the transfer it describes.
   */
  const boxes = useMemo(() => {
    const known = knownBoxes(session.address, session.chainId).boxes;
    return new Set([...known].map((b) => b.toLowerCase()));
  }, [session.address, session.chainId]);

  const entries: readonly ActivityEntry[] = useMemo(() => {
    if (view === 'sent') return sentEntries(sent.rows ?? [], t as never);
    if (view === 'history')
      return historyEntries(chainHistory.history?.entries ?? [], t as never, session.chainId);
    const mine = runs.filter((b) => isSubscriptionRun(b, boxes) === (view === 'subs'));
    return bridgeEntries(mine, t as never);
  }, [view, sent.rows, chainHistory.history, runs, boxes, session.chainId, t]);

  const facets = useMemo(() => {
    if (view === 'sent')
      return [
        { id: 'all', label: t('activity.f.all') },
        { id: 'undoable', label: t('activity.f.undoable') },
        { id: 'pending', label: t('activity.f.pending') },
        { id: 'claimed', label: t('activity.f.claimed') },
        { id: 'refunded', label: t('activity.f.refunded') },
      ];
    if (view === 'history')
      return [
        { id: 'all', label: t('activity.f.all') },
        { id: 'received', label: t('activity.f.received') },
        { id: 'sent', label: t('activity.f.sent') },
        // The tokens this wallet has actually touched, rather than every token
        // the registry knows: a chip that always reads zero is a chip that only
        // ever costs a tap.
        ...tokenFacets(entries),
      ];
    return [
      { id: 'all', label: t('activity.f.all') },
      { id: 'arrived', label: t('activity.f.arrived') },
      { id: 'gateway', label: t('bridge.engine.gateway') },
      ...(view === 'bridge'
        ? [
            { id: 'cctp', label: t('bridge.engine.cctp') },
            { id: 'deposit', label: t('bridge.rowstep.deposit') },
          ]
        : []),
      { id: 'failed', label: t('activity.f.failed') },
    ];
  }, [view, entries, t]);

  const feed = useActivityFeed(entries, facets, PAGE_SIZE);

  // A chip belongs to the view that offered it. Carrying `undoable` into the
  // bridge list would filter every row out and read as an empty history.
  const { setFacet } = feed;
  useEffect(() => setFacet('all'), [view, setFacet]);

  async function onAction(entry: ActivityEntry, action: { id: string }) {
    if (action.id !== 'cancel') return;
    const id = entry.id.replace(/^sent-/, '');
    setBusy(action.id);
    try {
      await cancel(session.clients, BigInt(id));
      toast.push(t('active.cancelledToast', { id }), 'success');
      await sent.reload();
      onChange();
    } catch (e) {
      if (e instanceof TransferUnavailableError) {
        toast.push(t(`transfer.unavailable.${e.reason}` as never), 'error');
      } else {
        toast.push(e instanceof Error ? e.message : t('active.cancelFailed'), 'error');
      }
      // Resync: a cancel that failed because somebody claimed it first should
      // leave the row saying claimed, not saying it can still be cancelled.
      await sent.reload();
    } finally {
      setBusy(null);
    }
  }

  const loading =
    (view === 'sent' && sent.rows === null) ||
    (view === 'history' && chainHistory.history === null && chainHistory.error === null);

  return (
    <div className="activitytab">
      <div className="activitytab__seg">
        <SegmentedTabs
          tabs={[
            { id: 'sent', label: t('activity.v.sent') },
            { id: 'history', label: t('activity.v.history') },
            { id: 'bridge', label: t('activity.v.bridge') },
            { id: 'subs', label: t('activity.v.subs') },
          ]}
          value={view}
          onChange={(v) => setView(v as View)}
        />
      </div>
      <Card data-testid="activity-card">
        {view === 'history' && chainHistory.unsupported ? (
          <p className="hint" data-testid="activity-no-explorer">
            {t('activity.noExplorer')}
          </p>
        ) : view === 'history' && chainHistory.error && chainHistory.history === null ? (
          <div className="err-text">{chainHistory.error}</div>
        ) : (
          <ActivityScreen
            feed={feed}
            facets={facets}
            loading={loading}
            searchPlaceholder={t(`activity.search.${view}` as 'activity.search.sent')}
            emptyText={t(`activity.emptyIn.${view}` as 'activity.emptyIn.sent')}
            noMatchText={t('activity.noMatch')}
            onAction={(entry, action) => void guard(() => onAction(entry, action))}
            busyAction={busy}
            data-testid={`activity-${view}`}
          />
        )}
      </Card>
    </div>
  );
}

/**
 * One chip per token this wallet has actually moved, most-used first.
 *
 * The label comes off the row's own mark rather than from the facet id, which is
 * lowercased for matching. Upper-casing that back gave "CIRBTC" for a token whose
 * name is cirBTC, which is the sort of detail somebody checks a ticker against.
 */
function tokenFacets(entries: readonly ActivityEntry[]): { id: string; label: string }[] {
  const seen = new Map<string, { n: number; label: string }>();
  for (const e of entries) {
    const symbol = e.view.icon.kind === 'token' ? e.view.icon.symbol : undefined;
    for (const f of e.facets) {
      if (!f.startsWith('token:')) continue;
      const at = seen.get(f);
      if (at) at.n += 1;
      else seen.set(f, { n: 1, label: symbol ?? f.slice('token:'.length) });
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4)
    .map(([id, v]) => ({ id, label: v.label }));
}
