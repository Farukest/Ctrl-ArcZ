import type { Address, PublicClient } from 'viem';
import { ctrlArcZAbi } from '../abi/ctrlArcZ.js';
import { CTRL_ARCZ_ADDRESS } from '../chains/arcTestnet.js';
import { BlockscoutDataProvider } from './blockscoutProvider.js';
import { evaluateRisk } from './rules.js';
import { getLogsChunked } from '../events.js';
import type { IDataProvider, RiskInput, RiskReport } from './types.js';

export interface CheckOptions {
  /** Defaults to ArcScan/Blockscout. */
  provider?: IDataProvider;
  /** Used to read `isVerifiedRecipient` from the contract. Optional. */
  client?: PublicClient;
  /** Overrides the deployed CtrlArcZ address. */
  contractAddress?: Address;
  /** Injected in tests to make the freshness rule deterministic. */
  now?: Date;
  /**
   * The sender's verified recipients, pre-supplied by a dedicated indexer. When
   * present, the on-demand RecipientVerified log scan is skipped entirely — this
   * is what keeps the co-signer's precheck fast instead of scanning from the
   * deploy block on every call.
   */
  verifiedRecipients?: Address[];
  /**
   * Bound the fallback RecipientVerified scan to the last N blocks (when no
   * indexer list is supplied). Undefined scans from the deploy block.
   */
  verifiedRecipientsLookbackBlocks?: number;
}

/**
 * Layer 1 — run this before every send.
 *
 * Fetches what the rules need, then hands it to the pure rule engine. Data
 * sources that fail are recorded rather than swallowed: an incomplete check can
 * return `warning`, never `safe`. A firewall that silently degrades to "looks
 * fine" when its data source is down is worse than no firewall.
 */
export async function check(
  sender: Address,
  target: Address,
  options: CheckOptions = {},
): Promise<RiskReport> {
  const provider = options.provider ?? new BlockscoutDataProvider();
  const unavailable: string[] = [];
  let sendHistoryOk = true;

  const [counterpartyScan, targetActivity, zeroValueCount, verified, verifiedRecipientsResult] =
    await Promise.all([
      provider.getOutgoingCounterparties(sender).catch(() => {
        // A fetch failure means the lookalike rule cannot run at all: fail closed
        // (lookalikeCheckable=false → an unverified target is blocked, not warned).
        unavailable.push('send history');
        sendHistoryOk = false;
        return { counterparties: [] as Address[], complete: true };
      }),
      provider.getAddressActivity(target).catch(() => {
        unavailable.push('recipient address history');
        return { transactionCount: 0, firstSeenAt: null };
      }),
      provider.countZeroValueTransfers(target, sender).catch(() => {
        unavailable.push('zero-value transfer scan');
        return 0;
      }),
      readVerifiedRecipient(sender, target, options),
      readVerifiedRecipients(sender, options, unavailable),
    ]);

  // A truncated history (more counterparties than the scan cap) is not a clean
  // "safe": a lookalike could match a counterparty we did not page far enough to
  // see. Mark the report incomplete so it degrades to at least a warning. (This is
  // softer than a fetch failure — we did scan the most-recent counterparties — so
  // it warns rather than hard-blocks.)
  if (!counterpartyScan.complete) unavailable.push('send history (partial scan)');
  const rawCounterparties = counterpartyScan.counterparties;

  // A verified recipient (from a settled protected transfer) is a known-good
  // address, so its lookalike must be caught too — layer 3 feeding back into
  // layer 1. Protected-transfer payments go to the contract, not the recipient
  // directly, so they never appear in raw counterparty history; the contract's
  // RecipientVerified events are the source for them.
  const verifiedRecipients = verifiedRecipientsResult.recipients;
  const counterparties = [...new Set([...rawCounterparties, ...verifiedRecipients])];

  // A PARTIAL verified-recipients set is as dangerous to the lookalike rule as a
  // partial send history: a protected-transfer recipient the bounded scan did not
  // reach is one whose lookalike passes as "safe". So a bounded/failed verified
  // scan makes the lookalike rule uncheckable too — fail closed, exactly as a send
  // history fetch failure does. This is what stops the firewall silently narrowing
  // to a few-hours window when the server's from-deploy-block index is unavailable.
  if (!verifiedRecipientsResult.complete) unavailable.push('verified recipients (partial scan)');
  const lookalikeCheckable = sendHistoryOk && verifiedRecipientsResult.complete;

  const input: RiskInput = {
    sender,
    target,
    counterparties,
    targetActivity,
    zeroValueBait: { count: zeroValueCount },
    isVerifiedRecipient: verified,
    lookalikeCheckable,
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };

  return evaluateRisk(input, options.now ?? new Date());
}

/**
 * The sender's verified recipients, read from the contract's RecipientVerified
 * events, WITH whether that read was complete.
 *
 * `complete` is the important half. It is true only when the set is authoritative:
 * a pre-supplied indexer list, an unbounded from-deploy-block scan, or a genuinely
 * empty source (no contract). It is false for a BOUNDED lookback scan — which can
 * silently omit anyone paid before the window — and for a fetch failure. The caller
 * folds `complete` into `lookalikeCheckable`, so a bounded/failed read fails closed
 * instead of passing a few-hours window off as the whole history.
 */
async function readVerifiedRecipients(
  sender: Address,
  options: CheckOptions,
  unavailable: string[],
): Promise<{ recipients: Address[]; complete: boolean }> {
  // Indexer path: a pre-supplied list means no on-chain scan at all, and it is
  // authoritative (the server backfills it from the deploy block).
  if (options.verifiedRecipients) return { recipients: options.verifiedRecipients, complete: true };

  const address = options.contractAddress ?? CTRL_ARCZ_ADDRESS;
  // No contract to read from: there are genuinely no verified recipients, and that
  // is a complete answer, not a gap.
  if (!options.client || /^0x0+$/.test(address)) return { recipients: [], complete: true };

  try {
    // Chunked, and from the deploy block by default — Arc caps eth_getLogs at 10k
    // blocks and rejects a from-0 query. A lookback bound trims the scan when there
    // is no indexer, and a bounded scan is by definition incomplete.
    let fromBlock: bigint | undefined;
    if (options.verifiedRecipientsLookbackBlocks != null) {
      const latest = await options.client.getBlockNumber();
      const back = BigInt(options.verifiedRecipientsLookbackBlocks);
      fromBlock = latest > back ? latest - back : 0n;
    }
    const logs = await getLogsChunked<{ recipient?: Address }>(options.client, {
      address,
      abi: ctrlArcZAbi,
      eventName: 'RecipientVerified',
      args: { sender },
      ...(fromBlock != null ? { fromBlock } : {}),
    });
    // Complete only if the scan reached the deploy block: either no lookback bound
    // was set, or the window was wide enough to start at 0.
    const complete = fromBlock == null || fromBlock === 0n;
    return {
      recipients: logs.map((log) => log.args.recipient).filter((r): r is Address => Boolean(r)),
      complete,
    };
  } catch {
    // Record the gap so the report is marked incomplete (never silently "safe").
    unavailable.push('verified recipients');
    return { recipients: [], complete: false };
  }
}

async function readVerifiedRecipient(
  sender: Address,
  target: Address,
  options: CheckOptions,
): Promise<boolean> {
  const address = options.contractAddress ?? CTRL_ARCZ_ADDRESS;
  if (!options.client || /^0x0+$/.test(address)) return false;

  try {
    return await options.client.readContract({
      address,
      abi: ctrlArcZAbi,
      functionName: 'isVerifiedRecipient',
      args: [sender, target],
    });
  } catch {
    // A missing contract read is not a risk signal; treat as "not yet verified".
    return false;
  }
}
