import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useT, useI18n } from '../i18n/context.js';
import { classifyFailure, failureText } from '../failure.js';
import type { TranslationKey } from '../i18n/en.js';
import { useTheme } from './theme.js';
import {
  IconCheck,
  IconChevron,
  IconChevronsLeft,
  IconChevronsRight,
  IconClose,
  IconCopy,
  IconGlobe,
  IconMoon,
  IconSun,
  IconInfo,
  IconAlert,
  IconSearch,
  IconExternal,
} from './icons.js';

/** Short 0x…abcd address form used everywhere. */
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* Hooks ------------------------------------------------------------------- */

/**
 * Synchronous double-submit guard. The ref flips before React re-renders, so a
 * second click (or a replayed tap) in the same tick is dropped even if the
 * button has not visually disabled yet. Returns a `run` that no-ops while busy.
 */
export function useSubmitGuard(): <T>(fn: () => Promise<T>) => Promise<T | undefined> {
  const busy = useRef(false);
  return useCallback(async <T,>(fn: () => Promise<T>) => {
    if (busy.current) return undefined;
    busy.current = true;
    try {
      return await fn();
    } finally {
      busy.current = false;
    }
  }, []);
}

function useIsMobile(query = '(max-width: 560px)'): boolean {
  // Lazy initial value from matchMedia so the very first render is already
  // correct (no popover->sheet flash if the viewport was resized before open).
  const [m, setM] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/* Button ------------------------------------------------------------------ */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'md' | 'sm';
  full?: boolean;
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  full,
  loading,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    `btn--${variant}`,
    size === 'sm' && 'btn--sm',
    full && 'btn--full',
    loading && 'is-loading',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden />}
      <span className="btn__label">{children}</span>
    </button>
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      className={['iconbtn', active && 'is-active', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

/* Card -------------------------------------------------------------------- */
export function Card({
  title,
  subtitle,
  info,
  infoLabel,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  /**
   * What this card is, for the people who want to know, behind the `i` beside the
   * title.
   *
   * Every one of these started life as a paragraph above the form. They are all
   * true and none of them is what somebody came to the screen to do, so they push
   * the fields down and get skipped anyway. Behind the title they are one click
   * away and cost nothing to the person who already knows.
   *
   * It is a prop on `Card` rather than something each screen assembles so that the
   * dot is the same size and sits in the same place every time. Three screens
   * placing it themselves is how one of them ends up a few pixels low.
   */
  info?: ReactNode;
  /** Accessible name for the info button. Falls back to a generic label. */
  infoLabel?: string;
  children: ReactNode;
  className?: string;
} & { [k: `data-${string}`]: string }) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')} {...rest}>
      {title && (
        <h2 className="card__title">
          <span className="card__title-text">{title}</span>
          {info && <InfoPopover label={infoLabel}>{info}</InfoPopover>}
        </h2>
      )}
      {subtitle && <p className="card__subtitle">{subtitle}</p>}
      {children}
    </section>
  );
}

/* Field / Input ----------------------------------------------------------- */
export function Field({
  label,
  error,
  hint,
  accent,
  children,
}: {
  label?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  /**
   * Marks the one field on a form that decides the rest of it. Colours the label
   * only, in the theme's accent, and deliberately not in the link blue: this is a
   * label, and a label that looks clickable is a label people click.
   */
  accent?: boolean;
  children: ReactNode;
}) {
  // Associate the label with the control so screen readers name the field. When the
  // child is a single element (Input/Select), give it the id and point htmlFor at it.
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, {
        id: (children.props as { id?: string }).id ?? id,
      })
    : children;
  return (
    <div className="field">
      {label && (
        <label
          className={accent ? 'field__label field__label--accent' : 'field__label'}
          htmlFor={id}
        >
          {label}
        </label>
      )}
      <div className="field__control">{control}</div>
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field__hint">{hint}</span>
      )}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  mono?: boolean;
  invalid?: boolean;
  sm?: boolean;
  /**
   * Put a clear button at the right edge, shown only when there is something to
   * clear.
   *
   * For the fields people paste into: an address is 42 characters nobody retypes,
   * and replacing one meant selecting all of it first. Selecting all of a long
   * mono string inside a narrow field is exactly the fiddly gesture a clear button
   * exists to remove.
   *
   * Handed the empty value through the same `onChange` the field already uses, so
   * every consumer's validation, risk check and dirty tracking see a clear the way
   * they see a deletion, with nothing new to subscribe to.
   */
  onClear?: () => void;
};
export function Input({ mono, invalid, sm, className, onClear, ...rest }: InputProps) {
  const t = useT();
  const ref = useRef<HTMLInputElement | null>(null);
  const clearable = Boolean(onClear) && String(rest.value ?? '').length > 0 && !rest.disabled;
  const cls = [
    'input',
    mono && 'input--mono',
    sm && 'input--sm',
    invalid && 'is-invalid',
    clearable && 'input--clearable',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const field = <input ref={ref} className={cls} aria-invalid={invalid || undefined} {...rest} />;
  if (!onClear) return field;

  return (
    <span className="inputwrap">
      {field}
      {clearable && (
        <button
          type="button"
          className="inputwrap__clear"
          // Not a submit, and not a focus steal: the caret goes back where it was
          // so the next thing typed lands in the field that was just emptied.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onClear();
            ref.current?.focus();
          }}
          aria-label={t('common.clear')}
          title={t('common.clear')}
          data-testid="input-clear"
        >
          <IconClose width={14} height={14} />
        </button>
      )}
    </span>
  );
}

/* Select (custom, portal; bottom-sheet on mobile, popover on desktop) ------ */
export interface SelectOption {
  value: string;
  label: ReactNode;
  /**
   * What the closed control shows, when that differs from the row.
   *
   * A row can afford more than a trigger: the token picker puts the balance
   * beside the symbol in the list, and the trigger is a chip next to an amount
   * field where a second number would be read as part of the amount.
   */
  triggerLabel?: ReactNode;
  /** Optional leading icon, shown in both the trigger and the menu row. */
  icon?: ReactNode;
  /** Plain text used for search filtering (falls back to a string label). */
  text?: string;
  /**
   * Present but not choosable, with the reason in place of its trailing value.
   *
   * For an option that genuinely exists and genuinely cannot be picked. Leaving
   * it out of the list makes the reader wonder whether the app knows about it;
   * showing it greyed with "needs an allowlist" answers that before they ask.
   */
  disabled?: boolean;
}

function optionText(o: SelectOption): string {
  return o.text ?? (typeof o.label === 'string' ? o.label : o.value);
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  full,
  disabled,
  searchable,
  searchPlaceholder,
  noResultsText,
  placeholder,
  id,
  variant = 'field',
  align = 'start',
  'data-testid': testId,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  full?: boolean;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  noResultsText?: string;
  /**
   * `field` is the form control. `chip` is the same control sized to sit in a row
   * of 38px header buttons: shorter, no chevron gap to spare, and it drops its
   * label under 480px so a long network name cannot push the wordmark off screen.
   */
  variant?: 'field' | 'chip';
  /** Which edge of the trigger the panel hangs from. See {@link AnchoredLayer}. */
  align?: 'start' | 'center' | 'end';
  'data-testid'?: string;
  /** What the trigger says before anything is chosen. Without it an unset select is
   *  an empty box, which reads as broken rather than as waiting. */
  placeholder?: string;
  id?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => optionText(o).toLowerCase().includes(q)) : options;

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <button
        ref={anchor}
        id={id}
        type="button"
        className={[
          'select-trigger',
          variant === 'chip' && 'select-trigger--chip',
          full && 'select-trigger--full',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => (open ? close() : setOpen(true))}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
      >
        <span className="select-trigger__value">
          {current?.icon}
          <span
            className={
              current ? 'select-trigger__text' : 'select-trigger__text select-trigger__text--ph'
            }
          >
            {current ? (current.triggerLabel ?? current.label) : (placeholder ?? '')}
          </span>
        </span>
        <IconChevron className={open ? 'select-trigger__chev is-open' : 'select-trigger__chev'} />
      </button>
      <AnchoredLayer
        anchorRef={anchor}
        open={open}
        onClose={close}
        label={ariaLabel}
        align={align}
        cap={variant === 'chip' ? 380 : undefined}
      >
        {searchable && (
          <div className="menu__search">
            <IconSearch className="menu__search-icon" width={15} height={15} />
            <input
              ref={searchRef}
              className="menu__search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? ''}
              aria-label={searchPlaceholder ?? ariaLabel}
              autoComplete="off"
            />
            {/* The same affordance the address fields have. A search that has
                filtered a long list down to nothing is exactly where someone wants
                to start over, and selecting the text to delete it is the slow way
                to do that on a phone. Same behaviour too: the caret goes back to
                the box, so the next thing typed lands in the field just emptied. */}
            {query !== '' && (
              <button
                type="button"
                className="inputwrap__clear menu__search-clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                aria-label={t('common.clear')}
                title={t('common.clear')}
                data-testid="menu-search-clear"
              >
                <IconClose width={14} height={14} />
              </button>
            )}
          </div>
        )}
        <div className="menu__list">
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={['menu__item', o.value === value && 'is-selected']
                .filter(Boolean)
                .join(' ')}
              disabled={o.disabled ?? false}
              aria-disabled={o.disabled ?? undefined}
              onClick={() => {
                if (o.disabled) return;
                onChange(o.value);
                close();
              }}
            >
              <span className="menu__item-label">
                {o.icon}
                <span className="menu__item-text">{o.label}</span>
              </span>
              {o.value === value && <IconCheck width={16} height={16} />}
            </button>
          ))}
          {filtered.length === 0 && noResultsText && <p className="menu__empty">{noResultsText}</p>}
        </div>
      </AnchoredLayer>
    </>
  );
}

/**
 * Portal layer anchored to a trigger. Desktop: a popover that stays glued to the
 * anchor while the page scrolls (repositions on scroll/resize, flips above when
 * there is no room below, closes only when the anchor leaves the viewport). The
 * overlay does not block the page (pointer-events: none in CSS); click-away is a
 * document listener. Mobile: a bottom sheet with a scrim. Closes on Escape.
 */
function AnchoredLayer({
  anchorRef,
  open,
  onClose,
  label,
  align = 'start',
  cap,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  label?: string | undefined;
  /**
   * How the panel lines up with its trigger.
   *
   * `start` is right for a menu: the list belongs under the left edge of the
   * control it replaces. `center` is right for a round info dot, which is 24px
   * wide against a 280px panel -- hanging that panel off the dot's left edge puts
   * it wherever the dot happens to sit, which on a right-hand dot means mostly off
   * the screen. `end` is right for a control parked at the right edge of a header:
   * the viewport clamp below only right-aligns the panel when the trigger is near
   * the window edge, and the header sits inside a centred max-width column, so on
   * a wide screen a `start` panel would hang out past the column instead.
   */
  align?: 'start' | 'center' | 'end';
  /** Upper bound on the panel height, on top of the room-available cap. */
  cap?: number | undefined;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>();
  /**
   * The width this panel had when it opened, held for as long as it stays open.
   *
   * Nothing set a width, so the panel was sized by whatever was inside it at the
   * time. In a searchable menu that content changes on every keystroke: typing one
   * letter narrowed the token picker to the width of the one row that still
   * matched, a second letter replaced the rows with "No matching token" and it
   * changed size again, and because the left edge is computed from the width, the
   * whole panel slid sideways under the cursor each time. A menu resizing itself
   * while somebody is reading it is the thing this pins down.
   *
   * Measured on open, before any query has narrowed anything, so it is the width
   * of the full list -- and cleared on close, so a different list gets its own.
   */
  const pinnedWidth = useRef<number | null>(null);

  const reposition = useCallback(() => {
    if (isMobile || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      onClose();
      return;
    }
    // Measure the panel rather than assume it. The old guess of 200 was smaller
    // than the info popover actually is (280), so the clamp that was supposed to
    // keep it on screen let it hang 80px past the right edge and the text was cut
    // off. `minWidth` below never exceeds the trigger, so this cannot oscillate.
    const natural = Math.max(panelRef.current?.offsetWidth ?? 0, r.width, 200);
    if (pinnedWidth.current === null) pinnedWidth.current = natural;
    // Never wider than the window, however wide the list wanted to be.
    const width = Math.min(pinnedWidth.current, window.innerWidth - 16);
    const desired =
      align === 'center'
        ? r.left + r.width / 2 - width / 2
        : align === 'end'
          ? r.right - width
          : r.left;
    const left = Math.min(Math.max(8, desired), window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const openUp = below < 300 && above > below;
    // Cap the menu to the space available in the chosen direction so a long list
    // (e.g. all 11 bridge chains) scrolls inside the menu instead of running off
    // the bottom (or top) of the screen where it cannot be reached.
    //
    // `cap` narrows that further for menus that are not the page's main control.
    // Twenty networks against a 900px viewport filled the screen edge to edge from
    // a 38px chip, which reads as a takeover rather than a menu. The list still
    // holds every network; it scrolls, and the search box is right above it.
    const room = Math.max(160, (openUp ? above : below) - 14);
    const maxHeight = cap ? Math.min(room, cap) : room;
    setStyle(
      openUp
        ? { bottom: window.innerHeight - r.top + 6, left, width, maxHeight }
        : { top: r.bottom + 6, left, width, maxHeight },
    );
  }, [isMobile, anchorRef, onClose, align, cap]);

  useLayoutEffect(() => {
    if (open) reposition();
    // A closed panel forgets its width, so the next thing to open in this layer
    // measures itself rather than inheriting the last menu's shape.
    else pinnedWidth.current = null;
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);

    let onDocDown: ((e: MouseEvent) => void) | undefined;
    let onMove: (() => void) | undefined;
    if (!isMobile) {
      // Keep the popover glued to its anchor. Capture-phase scroll catches any
      // scroll container (nested ones included, since scroll does not bubble but
      // capture listeners still see it); resize handles viewport changes. We call
      // reposition synchronously rather than via rAF, which browsers throttle on
      // hidden/background tabs (and headless test runs).
      onMove = () => reposition();
      window.addEventListener('scroll', onMove, true);
      window.addEventListener('resize', onMove);
      onDocDown = (e) => {
        const target = e.target as Node;
        if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
        onClose();
      };
      document.addEventListener('mousedown', onDocDown, true);
    }

    const focusTarget = panelRef.current?.querySelector<HTMLElement>(
      '.menu__search-input, [role="option"], button',
    );
    focusTarget?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      if (onMove) {
        window.removeEventListener('scroll', onMove, true);
        window.removeEventListener('resize', onMove);
      }
      if (onDocDown) document.removeEventListener('mousedown', onDocDown, true);
    };
  }, [open, isMobile, onClose, reposition, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      className={`layer ${isMobile ? 'layer--sheet' : 'layer--popover'}`}
      onClick={isMobile ? onClose : undefined}
    >
      <div
        ref={panelRef}
        className="menu"
        style={isMobile ? undefined : style}
        role="listbox"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {isMobile && <span className="menu__grip" aria-hidden />}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* Checkbox / Switch ------------------------------------------------------- */
export function Checkbox({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span className="check__box" aria-hidden>
        <IconCheck width={13} height={13} />
      </span>
      <span className="check__label">{label}</span>
    </label>
  );
}

export function Switch({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" {...rest} />
      <span className="switch__track" aria-hidden>
        <span className="switch__thumb" />
      </span>
      {label && <span className="switch__label">{label}</span>}
    </label>
  );
}

/* Badge / StatusPill ------------------------------------------------------ */
export function Badge({
  children,
  tone,
  dot,
}: {
  children: ReactNode;
  tone?: 'test' | 'live' | 'neutral';
  dot?: boolean;
}) {
  const cls = ['badge', dot && 'badge--dot', tone && `badge--${tone}`].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}

export function StatusPill({ status, label }: { status: string; label?: ReactNode }) {
  return <span className={`status status--${status}`}>{label ?? status}</span>;
}

/* CopyButton / AddressChip ------------------------------------------------ */
export function CopyButton({ value, label }: { value: string; label?: string | undefined }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    // The async Clipboard API can reject (not focused, denied, insecure context);
    // catch it (no unhandled rejection) and fall back to a hidden-textarea copy.
    Promise.resolve(navigator.clipboard?.writeText(value))
      .then(done)
      .catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch {
          /* clipboard unavailable; nothing more we can do */
        }
      });
  }, [value]);
  return (
    <button
      className="addr__copy"
      onClick={copy}
      aria-label={label ?? t('common.copy')}
      title={copied ? t('common.copied') : (label ?? t('common.copy'))}
    >
      {copied ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
    </button>
  );
}

export function AddressChip({ address, full }: { address: string; full?: boolean }) {
  return (
    <span className="addr" title={address}>
      <span className="addr__text">{full ? address : short(address)}</span>
      <CopyButton value={address} />
    </span>
  );
}

/* Skeleton ---------------------------------------------------------------- */
export function Skeleton({
  width = '100%',
  height = 14,
  still = false,
}: {
  width?: string | number;
  height?: number;
  /**
   * Hold the space without the shimmer. The shimmer says "on its way"; where a
   * value simply cannot be read from here, holding the space is honest and
   * animating it is a promise that never lands.
   */
  still?: boolean;
}) {
  return (
    <span
      className={still ? 'skeleton skeleton--still' : 'skeleton'}
      style={{ display: 'block', width, height }}
      aria-hidden
    />
  );
}

/* SegmentedTabs ----------------------------------------------------------- */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="segtabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={['segtab', value === t.id && 'is-active'].filter(Boolean).join(' ')}
          onClick={() => onChange(t.id)}
          data-testid={`tab-${t.id}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* Info popover ------------------------------------------------------------ */
/**
 * A small info icon that reveals an explanation on click (not hover, so it never
 * flickers or fires by accident). Reuses AnchoredLayer, so it is a popover on
 * desktop and a bottom sheet on mobile, with click-away and Escape to close.
 */
export function InfoPopover({
  label,
  children,
}: {
  label?: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="infodot"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        data-testid="info-popover"
      >
        <span className="infodot__glyph" aria-hidden>
          i
        </span>
      </button>
      <AnchoredLayer
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={label}
        align="center"
      >
        <div className="infopop">{children}</div>
      </AnchoredLayer>
    </>
  );
}

/* Pagination --------------------------------------------------------------- */
export function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  const t = useT();
  if (pageCount <= 1) return null;
  const atStart = page <= 0;
  const atEnd = page >= pageCount - 1;
  return (
    <nav className="pagination" aria-label={t('common.pagination')}>
      <button
        className="pagination__btn"
        onClick={() => onChange(0)}
        disabled={atStart}
        aria-label={t('common.firstPage')}
        data-testid="page-first"
      >
        <IconChevronsLeft className="pagination__chev" />
      </button>
      <button
        className="pagination__btn"
        onClick={() => onChange(page - 1)}
        disabled={atStart}
        aria-label={t('common.prevPage')}
        data-testid="page-prev"
      >
        <IconChevron className="pagination__chev pagination__chev--prev" />
      </button>
      <span className="pagination__info" aria-current="page">
        {page + 1} / {pageCount}
      </span>
      <button
        className="pagination__btn"
        onClick={() => onChange(page + 1)}
        disabled={atEnd}
        aria-label={t('common.nextPage')}
        data-testid="page-next"
      >
        <IconChevron className="pagination__chev pagination__chev--next" />
      </button>
      <button
        className="pagination__btn"
        onClick={() => onChange(pageCount - 1)}
        disabled={atEnd}
        aria-label={t('common.lastPage')}
        data-testid="page-last"
      >
        <IconChevronsRight className="pagination__chev" />
      </button>
    </nav>
  );
}

/** Clamp-safe page slice helper for lists. */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  return items.slice(page * size, page * size + size);
}

/* Tx link + copy (one chip: open in explorer, or copy the hash without leaving) */
export function TxLink({
  href,
  label,
  copyValue,
  copyLabel,
  title,
  onMouseEnter,
  onMouseLeave,
}: {
  href?: string | undefined;
  label: ReactNode;
  copyValue: string;
  copyLabel?: string | undefined;
  title?: string | undefined;
  onMouseEnter?: (() => void) | undefined;
  onMouseLeave?: (() => void) | undefined;
}) {
  return (
    <span className="txlink" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {href ? (
        <a className="txlink__go" href={href} target="_blank" rel="noreferrer" title={title}>
          {label}
          <IconExternal width={13} height={13} />
        </a>
      ) : (
        <span className="txlink__go" title={title}>
          {label}
        </span>
      )}
      <CopyButton value={copyValue} label={copyLabel} />
    </span>
  );
}

/* Search field (one modular control reused across every list) --------------- */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
} & { [k: `data-${string}`]: string }) {
  return (
    <div className="searchfield">
      <IconSearch className="searchfield__icon" width={16} height={16} aria-hidden />
      <input
        className="searchfield__input"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoComplete="off"
        {...rest}
      />
    </div>
  );
}

/**
 * Wraps a paginated list so the pagination control never jumps as you move
 * between pages: the container locks to the tallest page height seen (measured on
 * an unconstrained inner div, so there is no feedback loop), and a short last page
 * keeps that height instead of pulling everything up. `resetKey` re-measures when
 * the dataset changes (e.g. a new search), so filtering does not leave dead space.
 */
/**
 * Keeps a paginated list's height stable so the pagination bar underneath does
 * not shift as you move between full pages (no moving click target). It reserves
 * the tallest page seen — but only while `reserve` is true. Callers pass
 * `reserve={!isLastPage}` so the final, partial page collapses to its own content
 * instead of leaving a large empty gap above the controls.
 */
export function PagedList({
  children,
  resetKey,
  reserve = true,
}: {
  children: ReactNode;
  resetKey?: unknown;
  reserve?: boolean;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [minH, setMinH] = useState(0);
  useLayoutEffect(() => {
    const h = inner.current?.offsetHeight ?? 0;
    setMinH((prev) => (h > prev ? h : prev));
  });
  useEffect(() => {
    setMinH(0);
  }, [resetKey]);
  return (
    <div className="paged-list" style={reserve && minH ? { minHeight: minH } : undefined}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/* Modal ------------------------------------------------------------------- */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className={`layer layer--modal ${isMobile ? 'layer--sheet' : ''}`} onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {isMobile && <span className="menu__grip" aria-hidden />}
        {title && (
          <div className="modal__head">
            <h3 className="modal__title">{title}</h3>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* Toast system (top; dismissible; never covers the bottom of the screen) --- */
type ToastTone = 'info' | 'success' | 'error' | 'warn';
type Toast = { id: number; message: ReactNode; tone: ToastTone };
type ToastCtx = {
  push: (message: ReactNode, tone?: ToastTone) => void;
  /**
   * A failure, as one sentence.
   *
   * Every screen used to push `e.message`, which for a wallet error is a page of
   * request arguments, a decoded contract call, a docs link and a library
   * version. Cancelling an approval prompt produced all of that, and a person who
   * had just pressed Cancel had to read it to find out they had pressed Cancel.
   *
   * The whole text still goes to the console, where it is of use to somebody.
   *
   * `step` names the prompt it happened on, for the runs that ask twice in a row.
   * A translation key is translated; anything else is shown as given, so a caller
   * outside this app can pass a plain label and get the same result.
   */
  fail: (cause: unknown, opts?: { step?: string }) => void;
};
const ToastContext = createContext<ToastCtx | null>(null);

const TOAST_ICON: Record<ToastTone, ReactNode> = {
  info: <IconInfo width={16} height={16} />,
  success: <IconCheck width={16} height={16} />,
  error: <IconAlert width={16} height={16} />,
  warn: <IconAlert width={16} height={16} />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const t = useT();
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, message, tone }]);
      setTimeout(() => remove(id), 5000);
    },
    [remove],
  );
  const fail = useCallback<ToastCtx['fail']>(
    (cause, opts) => {
      const { benign, detail } = classifyFailure(cause);
      if (detail) console.debug('[ctrl-arcz]', detail, cause);
      const step = opts?.step ? t(opts.step as TranslationKey) : undefined;
      // Declining a prompt is an answer, not a fault, and colouring it like one
      // makes the wallet look broken to someone who did exactly what they meant.
      push(failureText(cause, t, step), benign ? 'warn' : 'error');
    },
    [push, t],
  );
  const value = useMemo<ToastCtx>(() => ({ push, fail }), [push, fail]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-wrap" role="region" aria-label={t('common.notifications')}>
        {toasts.map((x) => (
          <div key={x.id} className={`toast toast--${x.tone}`} role="status" aria-live="polite">
            <span className="toast__icon" aria-hidden>
              {TOAST_ICON[x.tone]}
            </span>
            <span className="toast__msg">{x.message}</span>
            <button
              className="toast__close"
              onClick={() => remove(x.id)}
              aria-label={t('common.close')}
            >
              <IconClose width={15} height={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

/* Theme toggle / Language menu ------------------------------------------- */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const t = useT();
  return (
    <IconButton
      label={theme === 'dark' ? t('common.themeLight') : t('common.themeDark')}
      onClick={toggle}
      data-testid="theme-toggle"
    >
      {theme === 'dark' ? <IconSun width={18} height={18} /> : <IconMoon width={18} height={18} />}
    </IconButton>
  );
}

export function LangMenu() {
  const { lang, setLang, locales } = useI18n();
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const current = locales.find((l) => l.code === lang);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="langbtn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('common.language')}
        data-testid="lang-menu"
      >
        <IconGlobe width={17} height={17} />
        <span className="langbtn__code">{current?.code.toUpperCase()}</span>
        <IconChevron width={14} height={14} />
      </button>
      <AnchoredLayer
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={t('common.language')}
      >
        {locales.map((l) => (
          <button
            key={l.code}
            type="button"
            role="option"
            aria-selected={l.code === lang}
            className={['menu__item', l.code === lang && 'is-selected'].filter(Boolean).join(' ')}
            onClick={() => {
              setLang(l.code);
              setOpen(false);
            }}
            data-testid={`lang-${l.code}`}
          >
            <span className="menu__item-label">{l.endonym}</span>
            {l.code === lang && <IconCheck width={16} height={16} />}
          </button>
        ))}
      </AnchoredLayer>
    </>
  );
}
