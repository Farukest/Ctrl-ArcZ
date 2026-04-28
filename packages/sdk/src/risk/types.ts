import type { Address } from 'viem';

/** `block` stops the send. `warning` asks the user to look again. `safe` proceeds. */
export type RiskLevel = 'safe' | 'warning' | 'block';

export type RiskRuleCode =
  /** The target looks like an address this sender has paid before, but is not it. */
  | 'LOOKALIKE_ADDRESS'
  /** The target has previously sent this sender a 0-value transfer (poisoning bait). */
  | 'ZERO_VALUE_BAIT'
  /** The target has no history at all. */
  | 'NEW_ADDRESS'
  /** The target's first activity is very recent. */
  | 'FRESH_ADDRESS'
  /** The sender has already completed a protected transfer to this address. */
  | 'VERIFIED_RECIPIENT'
  /** The sender has paid this exact address before. */
  | 'KNOWN_COUNTERPARTY'
  /** A data source was unavailable, so the check is incomplete. */
  | 'DATA_UNAVAILABLE';

export interface RiskReason {
  code: RiskRuleCode;
  severity: RiskLevel;
  /**
   * Human-readable English default. UIs may localize by `code` and use the
   * structured fields below (`lookalikeOf`, `count`, `sources`); this string is
   * the fallback when no translation exists.
   */
  message: string;
  /** The counterparty a lookalike was matched against, when relevant. */
  lookalikeOf?: Address;
  /** How many 0-value baits were seen (ZERO_VALUE_BAIT). */
  count?: number;
  /** Data sources that did not answer (DATA_UNAVAILABLE). */
  sources?: string[];
}

export interface RiskReport {
  target: Address;
  sender: Address;
  level: RiskLevel;
  reasons: RiskReason[];
  /** True when every data source answered. A partial check never reports `safe`. */
  complete: boolean;
}

/** One counterparty the sender has previously sent value to. */
export interface Counterparty {
  address: Address;
}

export interface AddressActivity {
  /** Total transactions sent from the address. */
  transactionCount: number;
  /** Timestamp of the earliest activity seen, or null when the address is unused. */
  firstSeenAt: Date | null;
}

export interface ZeroValueBait {
  /** How many 0-value transfers the target has sent to the sender. */
  count: number;
}

/**
 * Everything the rule engine needs, already fetched. Keeping this a plain value
 * makes the rules a pure function: no network, no client, fully unit-testable.
 */
export interface RiskInput {
  sender: Address;
  target: Address;
  /** Addresses the sender has paid before. */
  counterparties: Address[];
  targetActivity: AddressActivity;
  zeroValueBait: ZeroValueBait;
  /** From the contract: has a protected transfer to this address ever settled? */
  isVerifiedRecipient: boolean;
  /** Set when a data source failed; the report is then marked incomplete. */
  unavailable?: string[];
  /**
   * False when the sender's payment history could not be fetched, so the
   * lookalike rule could not run. The firewall then fails closed: an unverified
   * target is blocked, never merely warned, because a lookalike cannot be ruled
   * out. Defaults to true (history available).
   */
  lookalikeCheckable?: boolean;
}

/**
 * Where risk data comes from. The rule engine never talks to the network; swap
 * this to use a different indexer, an internal exchange database, or a cache.
 */
export interface IDataProvider {
  /** Addresses this sender has previously sent value to. */
  getOutgoingCounterparties(sender: Address): Promise<Address[]>;
  /** Activity summary for an address. */
  getAddressActivity(address: Address): Promise<AddressActivity>;
  /** 0-value transfers sent from `from` to `to` — the poisoning bait. */
  countZeroValueTransfers(from: Address, to: Address): Promise<number>;
}
