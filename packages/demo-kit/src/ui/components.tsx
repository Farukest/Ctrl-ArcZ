import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useT, useI18n } from '../i18n/context.js';
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
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
} & { [k: `data-${string}`]: string }) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')} {...rest}>
      {title && <h2 className="card__title">{title}</h2>}
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
  children,
}: {
  label?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
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
        <label className="field__label" htmlFor={id}>
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
};
export function Input({ mono, invalid, sm, className, ...rest }: InputProps) {
  const cls = [
    'input',
    mono && 'input--mono',
    sm && 'input--sm',
    invalid && 'is-invalid',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <input className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

/* Select (custom, portal; bottom-sheet on mobile, popover on desktop) ------ */
export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Optional leading icon, shown in both the trigger and the menu row. */
  icon?: ReactNode;
  /** Plain text used for search filtering (falls back to a string label). */
  text?: string;
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
  id,
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
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
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
        className={['select-trigger', full && 'select-trigger--full'].filter(Boolean).join(' ')}
        onClick={() => (open ? close() : setOpen(true))}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="select-trigger__value">
          {current?.icon}
          <span className="select-trigger__text">{current?.label ?? ''}</span>
        </span>
        <IconChevron className={open ? 'select-trigger__chev is-open' : 'select-trigger__chev'} />
      </button>
      <AnchoredLayer anchorRef={anchor} open={open} onClose={close} label={ariaLabel}>
        {searchable && (
          <div className="menu__search">
            <IconSearch className="menu__search-icon" width={15} height={15} />
            <input
              className="menu__search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? ''}
              aria-label={searchPlaceholder ?? ariaLabel}
              autoComplete="off"
            />
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
              onClick={() => {
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
  children,
}: {
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  label?: string | undefined;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>();

  const reposition = useCallback(() => {
    if (isMobile || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      onClose();
      return;
    }
    const width = Math.max(r.width, 200);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const openUp = below < 300 && above > below;
    // Cap the menu to the space available in the chosen direction so a long list
    // (e.g. all 11 bridge chains) scrolls inside the menu instead of running off
    // the bottom (or top) of the screen where it cannot be reached.
    const maxHeight = Math.max(160, (openUp ? above : below) - 14);
    setStyle(
      openUp
        ? { bottom: window.innerHeight - r.top + 6, left, minWidth: r.width, maxHeight }
        : { top: r.bottom + 6, left, minWidth: r.width, maxHeight },
    );
  }, [isMobile, anchorRef, onClose]);

  useLayoutEffect(() => {
    if (open) reposition();
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
}: {
  width?: string | number;
  height?: number;
}) {
  return <span className="skeleton" style={{ display: 'block', width, height }} aria-hidden />;
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
export function InfoPopover({ label, children }: { label?: string; children: ReactNode }) {
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
      <AnchoredLayer anchorRef={anchor} open={open} onClose={() => setOpen(false)} label={label}>
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
type ToastCtx = { push: (message: ReactNode, tone?: ToastTone) => void };
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
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, message, tone }]);
      setTimeout(() => remove(id), 5000);
    },
    [remove],
  );
  const t = useT();
  return (
    <ToastContext.Provider value={{ push }}>
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
