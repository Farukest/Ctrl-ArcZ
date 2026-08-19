import type { ReactNode } from 'react';
import { Button, Skeleton } from './components.js';
import { Input } from './components.js';
import { Select, type SelectOption } from './components.js';
import { useT } from '../i18n/context.js';
import { sanitizeAmount } from './amount.js';

/**
 * Putting the wallet's own USDC into its Gateway balance.
 *
 * One component in two places. The bridge spends this balance to move money between
 * chains and the subscription screen spends it to fund a policy box, and in both the
 * user has to be able to top it up without leaving the form they are filling in.
 * Written twice it would be two copies of a chain picker, a max that has to allow
 * for gas, and a wait that differs per chain -- and the first change to either is
 * where they would start disagreeing.
 *
 * The chain is chosen here and the caller's source chain follows it. A deposit is
 * only spendable on the chain it was made on, so two independent pickers is exactly
 * how a screen ends up showing a zero balance beside a deposit box aimed elsewhere.
 */
export interface GatewayFundBoxProps {
  /** Chain the deposit lands on, and the caller's source chain. */
  chain: string;
  chainOptions: SelectOption[];
  onChainChange: (chain: string) => void;
  /** Gateway balance on `chain`, in USDC subunits. `null` while unread. */
  balance: bigint | null;
  /**
   * Why the balance is missing, when it is. `loading` shimmers, `unavailable`
   * holds still: a shimmer promises a number is coming, and where Circle simply
   * did not answer, that promise is never kept. Defaults to `loading`.
   */
  balanceMissing?: 'loading' | 'unavailable';
  /**
   * The most that can be moved in from the wallet on this chain, gas allowed for.
   * `null` when the wallet's balance cannot be read from here, which is not zero.
   */
  maxDeposit: bigint | null;
  amount: string;
  onAmountChange: (next: string) => void;
  onDeposit: () => void;
  busy?: boolean;
  /** True when the wallet is on `chain`; a deposit is the one act that needs it. */
  walletOnChain: boolean;
  /** Deposited, on chain, not yet counted by Circle. */
  pending?: bigint;
  /** How long a deposit takes to count here, already worded. */
  wait: string;
  /** Formats subunits for display; the caller owns the money vocabulary. */
  format: (subunits: bigint) => string;
  children?: ReactNode;
}

export function GatewayFundBox({
  chain,
  chainOptions,
  onChainChange,
  balance,
  balanceMissing = 'loading',
  maxDeposit,
  amount,
  onAmountChange,
  onDeposit,
  busy = false,
  walletOnChain,
  pending = 0n,
  wait,
  format,
  children,
}: GatewayFundBoxProps) {
  const t = useT();
  const value = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
  })();
  // More than the wallet holds is not a deposit, it is a revert after a signature.
  const tooBig = maxDeposit != null && value > maxDeposit;

  return (
    <div className="gwfund" data-testid="gateway-deposit-box">
      <div className="gwfund__head">
        <span className="gwfund__title">{t('bridge.gwFundTitle')}</span>
        <output className="gwfund__figure" data-testid="gateway-balance">
          {balance == null ? (
            <Skeleton width={92} height={17} still={balanceMissing === 'unavailable'} />
          ) : (
            `${format(balance)} USDC`
          )}
        </output>
      </div>
      <div className="gwfund__pickrow">
        <Select
          value={chain}
          options={chainOptions}
          onChange={onChainChange}
          ariaLabel={t('bridge.from')}
          searchable
          searchPlaceholder={t('bridge.searchChain')}
          noResultsText={t('common.noResults')}
        />
        {/* The figure is the button: pressing a balance fills the field it belongs
            to. What it shows is rounded for reading and what it fills in is exact,
            because only one of the two gets signed. */}
        <button
          type="button"
          className="gwfund__wallet"
          onClick={() => maxDeposit != null && onAmountChange(format(maxDeposit))}
          disabled={maxDeposit == null || maxDeposit <= 0n}
          data-testid="gateway-wallet-balance"
        >
          <span className="gwfund__walletk">{t('bridge.gwWalletLabel')}</span>
          <output className="gwfund__walletv">
            {/* Null here means the wallet is connected to another chain, so this
                balance cannot be read from where we are standing. That is a
                settled fact, not a pending one. */}
            {maxDeposit == null ? (
              <Skeleton width={78} height={13} still />
            ) : (
              `${format(maxDeposit)} USDC`
            )}
          </output>
        </button>
      </div>
      <div className="gwfund__row">
        <Input
          value={amount}
          onChange={(e) => onAmountChange(sanitizeAmount(e.target.value))}
          inputMode="decimal"
          placeholder="0.00"
          invalid={tooBig}
          aria-label={t('bridge.gwDepositCta')}
          data-testid="gateway-deposit-amount"
        />
        <Button
          disabled={value <= 0n || tooBig || busy}
          loading={busy}
          onClick={onDeposit}
          data-testid="gateway-deposit"
        >
          {t('bridge.gwDepositCta')}
        </Button>
      </div>
      {tooBig && (
        <span className="gwfund__err" data-testid="gateway-deposit-error">
          {t('bridge.gwDepositTooBig')}
        </span>
      )}
      {/* Two different reasons the figure above is missing, and until now only one
          of them was on screen. The other showed a held placeholder and nothing
          else: on a light background that is a blank space beside a label, which
          reads as a bug in the page rather than a wallet that did not answer. The
          read repeats on a timer, so this clears itself when the wallet recovers. */}
      {!walletOnChain ? (
        <span className="gwfund__note">{t('bridge.gwWalletOtherChain', { chain: chainLabelOf(chainOptions, chain) })}</span>
      ) : maxDeposit == null ? (
        <span className="gwfund__note" data-testid="gateway-wallet-unreadable">
          {t('bridge.gwWalletUnreadable', { chain: chainLabelOf(chainOptions, chain) })}
        </span>
      ) : null}
      {pending > 0n && (
        <span className="gwfund__note" data-testid="gateway-pending">
          {t('bridge.gwPending', { amount: format(pending) })}
        </span>
      )}
      <span className="gwfund__note">{wait}</span>
      {children}
    </div>
  );
}

/** The picker already knows every chain's name; asking the caller for it again is
 *  one more thing two screens could answer differently. */
function chainLabelOf(options: SelectOption[], value: string): string {
  const found = options.find((o) => o.value === value);
  return found ? (found.text ?? (typeof found.label === 'string' ? found.label : value)) : value;
}
