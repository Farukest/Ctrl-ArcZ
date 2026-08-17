import type { ReactNode } from 'react';
import { ChainLogo } from './ChainLogo.js';
import { Skeleton } from './components.js';
import { useT } from '../i18n/context.js';
import { fiat, formatAmount, sanitizeAmount } from './amount.js';

/**
 * The one way this app asks for an amount.
 *
 * There were four: Send, Pay, Private Pay and the subscription form each had a
 * label, a text input and their own idea of what could be typed into it, and the
 * bridge had a fifth with a balance beside it. Four implementations of one control
 * is four places for a rule to go missing, and the rule that went missing was
 * input filtering.
 *
 * **The balance is not a field.** It is rendered as `output`, has no change
 * handler and no writable value: it is read from state and never back. The only
 * thing a user can do with it is press it, and pressing it asks the owner for a
 * number through `onMax`. A balance that could be typed into is a balance the
 * screen would then believe.
 */
export interface AmountFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Field label. Just "Amount": the pill on the right already names the token. */
  label?: ReactNode;
  /** Chain whose logo rides in the token pill, so the amount names its network. */
  chain?: string;
  /** Balance in the token's own subunits. Never zero when unknown: a zero is a
   *  claim about the balance and an unread balance is not one. */
  balance?: bigint | null;
  /**
   * Why the balance is missing, when it is.
   *
   * `loading` is a shimmer, because something is on its way. `unavailable` is a
   * still placeholder, because nothing is: the receiving side of a bridge cannot
   * read a balance on a chain the wallet is not connected to, and a shimmer there
   * promises a number that will never arrive. They were the same state until a
   * mobile screenshot showed the destination card shimmering forever.
   */
  balanceMissing?: 'loading' | 'unavailable';
  /** Word in front of the balance, because Gateway's is not the wallet's. */
  balanceLabel?: ReactNode;
  /**
   * What pressing the balance, or a percentage, should fill in. Given the
   * fraction so the owner can subtract a fee before answering: the field cannot
   * know that Gateway takes its fee out of the same balance.
   */
  onMax?: (fraction: number) => void;
  /** Quick fractions, as decimals. Empty or absent renders none. */
  percents?: readonly number[];
  /** Read-only mirror, for the receiving side of a bridge. */
  readOnly?: boolean;
  invalid?: boolean;
  error?: string | null;
  hint?: ReactNode;
  /**
   * Draw it as a panel of its own.
   *
   * The amount is the one field on any of these forms that is about money rather
   * than about addressing it, and the panel is what says so. Every screen that
   * asks for an amount on its own passes this: Send, Private Pay and the
   * subscription form, so the control looks the same wherever it is met.
   *
   * The bridge is the exception and not an inconsistency: its amount already
   * lives inside a `swapcard` with the chain picker, so boxing it again would be
   * a box in a box.
   */
  boxed?: boolean;
  /**
   * Base units per whole token, for the input filter.
   *
   * Defaults to six because that is USDC and every screen here started as a USDC
   * screen. It is a prop rather than a constant because a seventh decimal is a
   * rejected payment on a six-decimal token and a perfectly ordinary one on an
   * eight-decimal token, and the field is the only place that rule lives.
   */
  decimals?: number;
  /** What the pill says when there is nothing to pick. */
  symbol?: string;
  /**
   * A control in place of the static pill, for screens where the token is a
   * choice. The pill's job is to name the asset; when the asset can change, the
   * thing that names it should also be the thing that changes it, rather than a
   * separate select somewhere else on the form.
   */
  tokenSlot?: ReactNode;
  'data-testid'?: string;
}

export function AmountField({
  value,
  onChange,
  label,
  chain,
  balance,
  balanceLabel,
  balanceMissing = 'loading',
  onMax,
  percents,
  readOnly = false,
  invalid = false,
  error,
  hint,
  boxed = false,
  decimals = 6,
  symbol = 'USDC',
  tokenSlot,
  'data-testid': testId,
}: AmountFieldProps) {
  const t = useT();
  const canFill = onMax != null && balance != null && balance > 0n;
  /**
   * The dollar line is only true for a dollar token. `fiat` prints "$1.00" for
   * one unit, which is the whole point of it for USDC and a wrong exchange rate
   * for anything else. We do not carry a rate, so for other tokens the line is
   * omitted rather than guessed: no number is better than a made-up one next to
   * an amount someone is about to send.
   */
  const showsFiat = symbol === 'USDC';

  return (
    <div
      className={['amountf', boxed && 'amountf--boxed', invalid && 'amountf--invalid']
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      <div className="amountf__head">
        <span className="amountf__label">{label ?? t('amount.label')}</span>
        {balance !== undefined && (
          <button
            type="button"
            className="amountf__bal"
            onClick={() => onMax?.(1)}
            disabled={!canFill}
            data-testid={testId ? `${testId}-balance` : undefined}
          >
            <span className="amountf__balk">{balanceLabel ?? t('amount.balance')}</span>
            {/* `output` rather than a span: it is the element for a value the page
                computed, and it can never be typed into or submitted. */}
            <output className="amountf__balv">
              {balance == null ? (
                <Skeleton width={74} height={13} still={balanceMissing === 'unavailable'} />
              ) : (
                `${formatAmount(balance, decimals)} ${symbol}`
              )}
            </output>
          </button>
        )}
      </div>

      <div className="amountf__row">
        {readOnly ? (
          <output className="amountf__input amountf__input--out">{value || '0'}</output>
        ) : (
          <input
            className="amountf__input"
            value={value}
            // Filtered here and nowhere else, so no screen can hold a value the
            // others would refuse.
            onChange={(e) => onChange(sanitizeAmount(e.target.value, decimals))}
            inputMode="decimal"
            placeholder="0"
            aria-invalid={invalid || undefined}
            aria-label={typeof label === 'string' ? label : t('amount.label')}
            data-testid={testId ? `${testId}-input` : undefined}
          />
        )}
        {tokenSlot ?? (
          <span className="usdcpill">
            {chain && <ChainLogo id={chain} size={20} />}
            {symbol}
          </span>
        )}
      </div>

      <div className="amountf__foot">
        <span className="amountf__fiat">{showsFiat ? fiat(value) : ''}</span>
        {percents && percents.length > 0 && (
          <span className="amountf__pcts">
            {percents.map((f) => (
              <button
                key={f}
                type="button"
                className="pctchip"
                onClick={() => onMax?.(f)}
                disabled={!canFill}
                data-testid={testId ? `${testId}-pct-${Math.round(f * 100)}` : undefined}
              >
                {Math.round(f * 100)}%
              </button>
            ))}
          </span>
        )}
      </div>

      {error ? (
        <span className="amountf__err" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="amountf__hint">{hint}</span>
      ) : null}
    </div>
  );
}
