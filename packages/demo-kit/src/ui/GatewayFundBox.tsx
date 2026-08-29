import type { ReactNode } from 'react';
import { Button, Skeleton } from './components.js';
import { Input } from './components.js';
import { ChainSelect } from './ChainSelect.js';
import { labelOf } from '../chainCatalog.js';
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
  onChainChange: (chain: string) => void;
  /**
   * What the Gateway balance already holds on each chain, for the picker.
   *
   * The list used to be eleven bare names, which asks the reader to remember
   * where their balance already is in order to decide where to add to it. It is
   * the balance rather than the wallet's USDC because that is the figure the app
   * has for every chain: reading eleven wallets would be eleven RPC round trips
   * for a dropdown.
   */
  balances?: Partial<Record<string, bigint>> | undefined;
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
  /**
   * How long a deposit takes to count here, as a duration and nothing more: `1s`
   * on Arc, `19m` on Base. `depositWaitLabel` produces it.
   *
   * The sentence around it belongs to this component, which is a change: both
   * callers used to build one and pass it in whole, so the same sentence existed
   * twice and the box could not fold it into the line about switching networks
   * without asking them both to change.
   */
  wait: string;
  /** Formats subunits for display; the caller owns the money vocabulary. */
  format: (subunits: bigint) => string;
  children?: ReactNode;
}

export function GatewayFundBox({
  chain,
  onChainChange,
  balances,
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
        {/* Named for the chain rather than "Gateway balance", which is what the
            card around it is already called and, on the bridge, what the From
            block calls a different and larger number two rows down. Two figures
            one screen apart under the same words is how a person decides the app
            cannot count. */}
        <span className="gwfund__title">
          {t('bridge.gwOnChain', { chain: labelOf(chain) })}
        </span>
        <output className="gwfund__figure" data-testid="gateway-balance">
          {balance == null ? (
            <Skeleton width={92} height={17} still={balanceMissing === 'unavailable'} />
          ) : (
            `${format(balance)} USDC`
          )}
        </output>
      </div>
      <div className="gwfund__pickrow">
        {/* Every chain Circle runs Gateway on, asked for by name rather than
            handed in as a list. Both callers used to build that array themselves,
            and one of them used a different label rule than the other. */}
        <ChainSelect
          purpose="gatewayDeposit"
          value={chain}
          onChange={onChainChange}
          meta={
            balances
              ? (c) => {
                  const held = balances[c] ?? 0n;
                  // Nothing rather than a zero: a row saying "0" for every chain
                  // you have not used is noise, and the ones that matter stop
                  // standing out.
                  return held > 0n ? <span>{format(held)}</span> : null;
                }
              : undefined
          }
          ariaLabel={t('bridge.from')}
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
      {/*
        One line of small print, and only ever one.

        These were four independent lines, each rendered when its own condition
        held, so the box was one line tall on a chain the wallet is already on and
        two on a chain it is not -- and changing the picker moved everything below
        it, which on this screen is the whole rest of the bridge. A control that
        makes the page jump under the cursor is a control people stop using.

        The fix is not to reserve two lines and leave one of them blank; it is that
        there was never more than one thing worth saying here. So the four states
        are ordered by urgency and the winner speaks alone, and the two that would
        otherwise be said together are said in one sentence: a pending deposit
        already implies the wait, and a wallet on another chain is a step on the way
        to the same wait. Every variant fits one line at 380px on all eleven
        Gateway chains, which is what keeps the height fixed rather than merely
        reserved.

        Order matters and used to be the other way round: the deposit note came
        first and hid the unreadable one, so a missing figure got an explanation
        about depositing. No figure is the more urgent fact, so it speaks first.

        The retry it promises is real, but it is not a timer: a read that failed
        leaves its entry stale, and the store asks again the next time the value is
        subscribed to, which is every render. Worth being exact about, because the
        promise is on screen.
      */}
      <div className="gwfund__notes">
        {maxDeposit == null ? (
          <span className="gwfund__note" data-testid="gateway-wallet-unreadable">
            {t('bridge.gwWalletUnreadable')}
          </span>
        ) : tooBig ? (
          <span className="gwfund__err" data-testid="gateway-deposit-error">
            {t('bridge.gwDepositTooBig')}
          </span>
        ) : pending > 0n ? (
          <span className="gwfund__note" data-testid="gateway-pending">
            {t('bridge.gwPending', { amount: format(pending), wait })}
          </span>
        ) : !walletOnChain ? (
          <span className="gwfund__note" data-testid="gateway-wallet-elsewhere">
            {t('bridge.gwWalletOtherChain', { wait })}
          </span>
        ) : (
          <span className="gwfund__note" data-testid="gateway-wait">
            {t('bridge.gwDepositWait', { wait })}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
