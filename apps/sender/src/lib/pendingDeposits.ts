import type { GatewayChain } from '@ctrl-arcz/sdk';

/**
 * Deposits this browser has made that Circle has not counted yet.
 *
 * A deposit is an ordinary transaction and lands on chain in seconds, but Circle
 * only credits it once the source chain reaches the confirmations it requires. On
 * Arc that is about a second; on Base it was measured at over twenty minutes, past
 * the published estimate. In that window the contract holds the money and the
 * balance still reads zero, so the screen said nothing at all about several USDC
 * that had definitely left the wallet. That is the worst thing a money screen can
 * do, and it is fixed with a note rather than a new RPC dependency: the browser
 * already knows what it deposited and when.
 *
 * Cleared when Circle's reported balance catches up, or after a day, whichever
 * comes first. A record that outlives its truth is its own kind of lie.
 */
export interface PendingDeposit {
  chain: GatewayChain;
  /** USDC subunits. */
  amount: bigint;
  at: number;
  /**
   * What Circle reported for this chain the moment before the deposit was sent,
   * which makes `before + amount` the figure the balance has to reach.
   *
   * This exists because the first version of this file could only see a deposit
   * being credited as a RISE between two consecutive polls, and a rise is not
   * something a browser can rely on noticing. The poll runs every twelve seconds
   * and Arc credits a deposit in about one, so the credit was routinely already
   * inside the first reading -- there was nothing left to rise, no later poll ever
   * saw one, and the row sat on "Counted by Circle" until it expired a day later
   * with the money long since spendable. Reloading the page re-took the baseline
   * and did the same thing again, so it could not even be cleared by hand.
   *
   * An absolute target has none of that: it does not care when the first reading
   * happened, it survives a reload, and it cannot be missed by arriving too fast.
   *
   * Optional because rows written by that earlier version are still in
   * localStorage, and because a deposit made while the balance could not be read
   * has no honest value to put here.
   */
  before?: bigint;
}

const KEY = 'ctrl-arcz:gateway-pending-deposits';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredDeposit = { chain: GatewayChain; amount: string; at: number; before?: string };

export function loadPendingDeposits(): PendingDeposit[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as StoredDeposit[];
    return rows
      .filter((r) => Date.now() - r.at < MAX_AGE_MS)
      .map((r) => ({
        chain: r.chain,
        amount: BigInt(r.amount),
        at: r.at,
        ...(r.before != null ? { before: BigInt(r.before) } : {}),
      }));
  } catch {
    return [];
  }
}

function write(rows: PendingDeposit[]): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        rows.map((r) => ({
          chain: r.chain,
          amount: r.amount.toString(),
          at: r.at,
          ...(r.before != null ? { before: r.before.toString() } : {}),
        })),
      ),
    );
  } catch {
    // Private mode or a full quota. The deposit is unaffected; only the note is.
  }
}

export function rememberDeposit(chain: GatewayChain, amount: bigint, before?: bigint): void {
  write([
    ...loadPendingDeposits(),
    { chain, amount, at: Date.now(), ...(before != null ? { before } : {}) },
  ]);
}

/**
 * Drop what Circle has caught up on, given what it reports for this chain now.
 *
 * Two rules, because there are two kinds of row.
 *
 * A row that knows the balance it started from is settled by the balance reaching
 * `before + amount`. That is a fact about the current reading alone, so it holds
 * however long ago the deposit was made, whoever was watching at the time, and
 * across a reload.
 *
 * A row without one is from the version that could only watch for a rise, and the
 * only thing left to check is whether the chain now reports at least what was put
 * into it. That is weaker, and it is deliberately not the rule for new rows; it
 * exists so the rows that version stranded can finish rather than spin for a day.
 *
 * Amounts are not matched to individual deposits either way, because Circle reports
 * a total and two deposits of the same size are indistinguishable inside it.
 */
export function reconcile(chain: GatewayChain, reported: bigint): void {
  const kept = loadPendingDeposits().filter((row) => {
    if (row.chain !== chain) return true;
    return row.before != null ? reported < row.before + row.amount : reported < row.amount;
  });
  write(kept);
}

/** What is still waiting on this chain, in USDC subunits. */
export function pendingOn(chain: GatewayChain): bigint {
  return loadPendingDeposits()
    .filter((r) => r.chain === chain)
    .reduce((sum, r) => sum + r.amount, 0n);
}
