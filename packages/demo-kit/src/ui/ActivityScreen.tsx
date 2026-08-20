import { useState, type ReactNode } from 'react';
import type {
  ActivityAction,
  ActivityDay,
  ActivityEntry,
  ActivityFacetOption,
  ActivityFeed,
  ActivityIcon,
  ActivitySort,
  ActivityStep,
} from '../index.js';
import { IconCheck, IconChevron, IconExternal } from './icons.js';
import { Button, CopyButton, Pagination, SearchField, Select, short } from './components.js';
import { ChainLogo } from './ChainLogo.js';
import { TokenLogo } from './TokenLogo.js';
import { deploymentFor, tokensFor } from '@ctrl-arcz/sdk';
import { useT } from '../i18n/context.js';

/**
 * The screen every list of things-that-happened is.
 *
 * Four of them existed, each assembled by hand out of the same parts and each
 * slightly different: one had a search box and no filters, one had filters and no
 * dates, one paged and one did not, and a row meant something different in each.
 * This is that screen written once. What differs between the four is the rows and
 * the chips, and both of those arrive as data.
 *
 * The detail opens inside the row rather than in a sheet over the page. On a phone
 * a sheet is right, because the list is the whole screen and there is nowhere else
 * to put it; in a browser the row has the width to hold its own detail, and
 * covering the list to explain one line of it is a step backwards from being able
 * to see both.
 */

function Mark({ icon }: { icon: ActivityIcon }) {
  if (icon.kind === 'route') {
    return (
      <span className="amark amark--route" aria-hidden>
        <ChainLogo id={icon.from} size={18} />
        <span className="amark__arrow">&rarr;</span>
        <ChainLogo id={icon.to} size={18} />
      </span>
    );
  }
  if (icon.kind === 'chain') {
    return (
      <span className="amark" aria-hidden>
        <ChainLogo id={icon.id} size={22} />
      </span>
    );
  }
  if (icon.kind === 'token') {
    /*
     * The token's own mark, resolved through the registry for the chain it moved
     * on, with that chain badged onto it and the direction under it.
     *
     * Resolved rather than guessed from the symbol: the same ticker is a different
     * contract on every network. An earlier version drew the four letters of the
     * ticker in a grey disc, which is what a token badge looks like when nobody
     * checked whether the app already had one. It did.
     */
    const token = tokensFor(icon.chainId)?.find((x) => x.symbol === icon.symbol);
    const chain = icon.chainId === undefined ? undefined : deploymentFor(icon.chainId);
    return (
      <span className={`amark amark--token amark--${icon.direction ?? 'none'}`} aria-hidden>
        {token ? (
          <TokenLogo token={token} size={26} />
        ) : (
          <span className="amark__sym">{icon.symbol.slice(0, 4)}</span>
        )}
        {chain && (
          <span className="amark__chain">
            <ChainLogo id={chain.chain} size={13} />
          </span>
        )}
        {icon.direction && (
          <span className="amark__dir">{icon.direction === 'in' ? '↓' : '↑'}</span>
        )}
      </span>
    );
  }
  return <span className={`amark amark--dot amark--tone-${icon.tone}`} aria-hidden />;
}

function Steps({ steps }: { steps: readonly ActivityStep[] }) {
  return (
    <ol className="asteps">
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className={`astep astep--${s.state}`}>
          <span className="astep__mark" aria-hidden>
            {s.state === 'done' ? (
              <IconCheck width={11} height={11} />
            ) : s.state === 'active' ? (
              <span className="spinner" style={{ width: 11, height: 11 }} />
            ) : s.state === 'error' ? (
              '!'
            ) : s.state === 'skipped' ? (
              '-'
            ) : (
              ''
            )}
          </span>
          <span className="astep__label">{s.label}</span>
          {s.txHash &&
            (s.href ? (
              <a className="astep__tx" href={s.href} target="_blank" rel="noreferrer">
                {short(s.txHash)}
                <IconExternal width={11} height={11} />
              </a>
            ) : (
              <span className="astep__tx">{short(s.txHash)}</span>
            ))}
        </li>
      ))}
    </ol>
  );
}

function Row({
  entry,
  open,
  onToggle,
  onAction,
  busyAction,
}: {
  entry: ActivityEntry;
  open: boolean;
  onToggle: () => void;
  onAction?: (entry: ActivityEntry, action: ActivityAction) => void;
  busyAction?: string | null;
}) {
  const t = useT();
  const { view } = entry;
  const expandable = entry.facts.length > 0 || !!entry.steps?.length || !!entry.actions?.length;

  return (
    <div className={`arow2${open ? ' is-open' : ''}`} data-testid="activity-item">
      {/* The whole head is the control, because the row is one thing and a reader
          aiming at a 16px chevron on a phone is a reader who misses. */}
      <button
        type="button"
        className="arow2__head"
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <Mark icon={view.icon} />
        <span className="arow2__body">
          <span className="arow2__title">{view.title}</span>
          {view.subtitle && (
            <span className="arow2__sub">
              <span className="arow2__subtext">{view.subtitle}</span>
              {view.subtitleCopy && <CopyButton value={view.subtitleCopy} />}
            </span>
          )}
        </span>
        <span className="arow2__right">
          {view.amount && <span className="arow2__amount mono">{view.amount}</span>}
          {view.status && (
            <span className={`hstatus hstatus--${view.status.tone}`}>{view.status.label}</span>
          )}
        </span>
        {expandable && <IconChevron className="arow2__chev" width={15} height={15} aria-hidden />}
      </button>

      {view.chips && view.chips.length > 0 && (
        <div className="arow2__chips">
          {view.chips.map((c) => (
            <span key={c} className="achip achip--plain">
              {c}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="arow2__detail">
          <dl className="afacts">
            {entry.facts.map((f) => (
              <div className="afact" key={f.label}>
                <dt>{f.label}</dt>
                <dd className={f.mono ? 'mono' : undefined} title={f.value}>
                  {f.href ? (
                    <a href={f.href} target="_blank" rel="noreferrer">
                      {f.display ?? f.value}
                      <IconExternal width={11} height={11} />
                    </a>
                  ) : (
                    (f.display ?? f.value)
                  )}
                  {f.copy && <CopyButton value={f.value} />}
                </dd>
              </div>
            ))}
          </dl>
          {entry.steps && entry.steps.length > 0 && (
            <>
              <div className="afacts__head">{t('activity.steps')}</div>
              <Steps steps={entry.steps} />
            </>
          )}
          {entry.actions && entry.actions.length > 0 && (
            <div className="arow2__actions">
              {entry.actions.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant={a.tone === 'danger' ? 'danger' : 'ghost'}
                  disabled={a.disabled ?? false}
                  loading={busyAction === a.id}
                  onClick={() => onAction?.(entry, a)}
                  data-testid={`activity-action-${a.id}`}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function dayLabel(day: number, t: ReturnType<typeof useT>): string {
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (day === midnight) return t('activity.today');
  if (day === midnight - 86_400_000) return t('activity.yesterday');
  return new Date(day).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** `yyyy-mm-dd` for a date input, in local time rather than UTC. */
function inputDate(day: number | null): string {
  if (day === null) return '';
  const d = new Date(day);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ActivityScreen({
  feed,
  facets,
  searchPlaceholder,
  emptyText,
  noMatchText,
  loading,
  onAction,
  busyAction,
  footer,
  'data-testid': testId,
}: {
  feed: ActivityFeed;
  facets: readonly ActivityFacetOption[];
  searchPlaceholder: string;
  emptyText: string;
  noMatchText: string;
  loading?: boolean;
  onAction?: (entry: ActivityEntry, action: ActivityAction) => void;
  busyAction?: string | null;
  /** Anything the screen wants under the pager, such as a source note. */
  footer?: ReactNode;
  'data-testid'?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const narrowed =
    feed.query.search.trim() !== '' || feed.query.facet !== 'all' || feed.query.day !== null;

  return (
    <div className="ascreen" data-testid={testId}>
      <div className="ascreen__tools">
        <SearchField
          value={feed.searchInput}
          onChange={feed.setSearch}
          placeholder={searchPlaceholder}
          data-testid="activity-search"
        />
        {/*
          A native date input behind a calendar button.
          A hand-built month grid is a month of edge cases -- locales, week start,
          keyboard, screen readers -- for a control every platform already ships,
          and the one it ships is the one the reader already knows.
        */}
        <label className={`ascreen__day${feed.query.day !== null ? ' is-set' : ''}`}>
          <input
            type="date"
            aria-label={t('activity.day')}
            title={t('activity.day')}
            value={inputDate(feed.query.day)}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return feed.setDay(null);
              const [y, m, d] = v.split('-').map(Number);
              feed.setDay(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime());
            }}
            data-testid="activity-day"
          />
        </label>
        <Select
          variant="chip"
          align="end"
          value={feed.query.sort}
          onChange={(v) => feed.setSort(v as ActivitySort)}
          ariaLabel={t('activity.sortBy')}
          options={[
            { value: 'newest', label: t('activity.sort.newest') },
            { value: 'oldest', label: t('activity.sort.oldest') },
            { value: 'largest', label: t('activity.sort.largest') },
          ]}
          data-testid="activity-sort"
        />
      </div>

      {/* Scrolls sideways rather than wrapping to three lines on a phone, which is
          how the same chips behave in the app this is modelled on. */}
      <div className="ascreen__facets" role="tablist" aria-label={t('activity.filter')}>
        {facets.map((f) => {
          const count = feed.counts[f.id] ?? 0;
          const active = feed.query.facet === f.id;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`afacet${active ? ' is-active' : ''}`}
              onClick={() => feed.setFacet(f.id)}
              data-testid={`activity-facet-${f.id}`}
            >
              {f.label}
              {f.id !== 'all' && <span className="afacet__n">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="ascreen__list" data-testid="activity-list">
        {loading && feed.page.total === 0 ? (
          <p className="hint" data-testid="activity-loading">
            {t('common.loading')}
          </p>
        ) : feed.page.total === 0 ? (
          <p className="hint" data-testid="activity-empty">
            {narrowed ? noMatchText : emptyText}
          </p>
        ) : (
          feed.days.map((group: ActivityDay) => (
            <div className="aday" key={group.day}>
              <div className="aday__label">{dayLabel(group.day, t)}</div>
              {group.entries.map((entry) => (
                <Row
                  key={entry.id}
                  entry={entry}
                  open={open === entry.id}
                  onToggle={() => setOpen(open === entry.id ? null : entry.id)}
                  {...(onAction ? { onAction } : {})}
                  busyAction={busyAction ?? null}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <Pagination
        page={feed.page.page - 1}
        pageCount={feed.page.pages}
        onChange={(p) => feed.setPage(p + 1)}
      />
      {footer}
    </div>
  );
}
