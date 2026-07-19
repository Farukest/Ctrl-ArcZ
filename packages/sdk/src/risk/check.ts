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

  const [rawCounterparties, targetActivity, zeroValueCount, verified, verifiedRecipients] =
    await Promise.all([
      provider.getOutgoingCounterparties(sender).catch(() => {
        unavailable.push('send history');
        sendHistoryOk = false;
        return [] as Address[];
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

  // A verified recipient (from a settled protected transfer) is a known-good
  // address, so its lookalike must be caught too — layer 3 feeding back into
  // layer 1. Protected-transfer payments go to the contract, not the recipient
  // directly, so they never appear in raw counterparty history; the contract's
  // RecipientVerified events are the source for them.
  const counterparties = [...new Set([...rawCounterparties, ...verifiedRecipients])];

  const input: RiskInput = {
    sender,
    target,
    counterparties,
    targetActivity,
    zeroValueBait: { count: zeroValueCount },
    isVerifiedRecipient: verified,
    lookalikeCheckable: sendHistoryOk,
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };

  return evaluateRisk(input, options.now ?? new Date());
}

/** The sender's verified recipients, read from the contract's RecipientVerified events. */
async function readVerifiedRecipients(
  sender: Address,
  options: CheckOptions,
  unavailable: string[],
): Promise<Address[]> {
  // Indexer path: a pre-supplied list means no on-chain scan at all.
  if (options.verifiedRecipients) return options.verifiedRecipients;

  const address = options.contractAddress ?? CTRL_ARCZ_ADDRESS;
  if (!options.client || /^0x0+$/.test(address)) return [];

  try {
    // Chunked, and from the deploy block by default — Arc caps eth_getLogs at 10k
    // blocks and rejects a from-0 query. A lookback bound trims the scan when there
    // is no indexer.
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
    return logs.map((log) => log.args.recipient).filter((r): r is Address => Boolean(r));
  } catch {
    // Record the gap so the report is marked incomplete (never silently "safe").
    unavailable.push('verified recipients');
    return [];
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
