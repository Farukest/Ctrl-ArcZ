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
}

const KEY = 'ctrl-arcz:gateway-pending-deposits';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function loadPendingDeposits(): PendingDeposit[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as { chain: GatewayChain; amount: string; at: number }[];
    return rows
      .filter((r) => Date.now() - r.at < MAX_AGE_MS)
      .map((r) => ({ chain: r.chain, amount: BigInt(r.amount), at: r.at }));
  } catch {
    return [];
  }
}

function write(rows: PendingDeposit[]): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(rows.map((r) => ({ chain: r.chain, amount: r.amount.toString(), at: r.at }))),
    );
  } catch {
    // Private mode or a full quota. The deposit is unaffected; only the note is.
  }
}

export function rememberDeposit(chain: GatewayChain, amount: bigint): void {
  write([...loadPendingDeposits(), { chain, amount, at: Date.now() }]);
}

/**
 * Drop what Circle has caught up on.
 *
 * Compares against the balance actually reported for that chain rather than
 * matching individual deposits, because Circle reports a total and two deposits of
 * the same size are indistinguishable in it.
 */
export function reconcile(chain: GatewayChain, reported: bigint, atLastCheck: bigint): void {
  if (reported <= atLastCheck) return;
  let credited = reported - atLastCheck;
  const kept: PendingDeposit[] = [];
  for (const row of loadPendingDeposits()) {
    if (row.chain !== chain || credited <= 0n) {
      kept.push(row);
      continue;
    }
    if (row.amount <= credited) credited -= row.amount;
    else kept.push({ ...row, amount: row.amount - credited });
  }
  write(kept);
}

/** What is still waiting on this chain, in USDC subunits. */
export function pendingOn(chain: GatewayChain): bigint {
  return loadPendingDeposits()
    .filter((r) => r.chain === chain)
    .reduce((sum, r) => sum + r.amount, 0n);
}
