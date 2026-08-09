import type { ReactNode } from 'react';
import { ChainLogo } from './ChainLogo.js';
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
  /** Field label. Just "Amount": the pill on the right already says USDC. */
  label?: ReactNode;
  /** Chain whose logo rides in the token pill, so the amount names its network. */
  chain?: string;
  /** Spendable balance in USDC subunits. `null` renders a dash, not a zero: a zero
   *  is a claim about the balance and an unread balance is not one. */
  balance?: bigint | null;
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
  'data-testid'?: string;
}

export function AmountField({
  value,
  onChange,
  label,
  chain,
  balance,
  balanceLabel,
  onMax,
  percents,
  readOnly = false,
  invalid = false,
  error,
  hint,
  boxed = false,
  'data-testid': testId,
}: AmountFieldProps) {
  const t = useT();
  const canFill = onMax != null && balance != null && balance > 0n;

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
              {balance == null ? '—' : `${formatAmount(balance)} USDC`}
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
            onChange={(e) => onChange(sanitizeAmount(e.target.value))}
            inputMode="decimal"
            placeholder="0"
            aria-invalid={invalid || undefined}
            aria-label={typeof label === 'string' ? label : t('amount.label')}
            data-testid={testId ? `${testId}-input` : undefined}
          />
        )}
        <span className="usdcpill">
          {chain && <ChainLogo id={chain} size={20} />}
          USDC
        </span>
      </div>

      <div className="amountf__foot">
        <span className="amountf__fiat">{fiat(value)}</span>
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
