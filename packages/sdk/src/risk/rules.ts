import type { Address } from 'viem';
import type { RiskInput, RiskLevel, RiskReason, RiskReport } from './types.js';

/**
 * Characters compared at each end of an address. Wallets abbreviate as
 * `0x3A5f…9C2b`, so an attacker only has to match the visible ends — which is
 * exactly what a vanity grinder produces in seconds.
 */
export const AFFIX_LENGTH = 4;

/** How recent an address's first activity must be to count as "fresh". */
export const FRESH_ADDRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const severityRank: Record<RiskLevel, number> = { safe: 0, warning: 1, block: 2 };

const normalise = (address: Address) => address.toLowerCase();
const prefix = (address: Address) => normalise(address).slice(2, 2 + AFFIX_LENGTH);
const suffix = (address: Address) => normalise(address).slice(-AFFIX_LENGTH);

/**
 * True when `candidate` shows the same visible ends as `known` while being a
 * different address — the signature of an address-poisoning lookalike.
 */
export function isLookalike(candidate: Address, known: Address): boolean {
  if (normalise(candidate) === normalise(known)) return false;
  return prefix(candidate) === prefix(known) && suffix(candidate) === suffix(known);
}

/**
 * Mints a real lookalike of `target`: same first and last `AFFIX_LENGTH` hex
 * characters, random middle. This is what the poisoning demo blocks — a genuine
 * address a wallet renders identically to the target. We construct it rather than
 * grind a keypair because the firewall decides from the address alone;
 * `randomBytes` lets a caller inject entropy for a deterministic test.
 */
export function craftLookalike(
  target: Address,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Address {
  const hex = normalise(target).slice(2);
  const head = hex.slice(0, AFFIX_LENGTH);
  const tail = hex.slice(-AFFIX_LENGTH);
  const middleLength = 40 - AFFIX_LENGTH * 2;

  const bytes = randomBytes(Math.ceil(middleLength / 2));
  const middle = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, middleLength);

  return `0x${head}${middle}${tail}` as Address;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Layer 1, the firewall. A pure function: same input, same verdict, no network.
 *
 * This is the protection that actually matters. In a poisoning attack the victim
 * sends to the wrong address *deliberately* — they believe it is the right one —
 * so escrowing the funds does not save them. Only refusing to send does.
 *
 * @param now Injected so the rules stay pure and testable.
 */
export function evaluateRisk(input: RiskInput, now: Date = new Date()): RiskReport {
  const reasons: RiskReason[] = [];

  // Rule (c): the target has baited this sender with a 0-value transfer. This is
  // not a heuristic — sending someone 0 tokens has no legitimate purpose; it
  // exists to plant an address in their history.
  if (input.zeroValueBait.count > 0) {
    reasons.push({
      code: 'ZERO_VALUE_BAIT',
      severity: 'block',
      count: input.zeroValueBait.count,
      message:
        input.zeroValueBait.count === 1
          ? 'This address sent you a 0-value transfer earlier. That is the signature of an address-poisoning attack: it plants the address in your history.'
          : `This address sent you ${input.zeroValueBait.count} zero-value transfers. That is the signature of an address-poisoning attack.`,
    });
  }

  // Rule (a): the target mimics the visible ends of an address the sender has
  // actually paid before.
  const lookalikeOf = input.counterparties.find((known) => isLookalike(input.target, known));
  if (lookalikeOf) {
    reasons.push({
      code: 'LOOKALIKE_ADDRESS',
      severity: 'block',
      message: `This address looks identical, by first and last characters, to ${shorten(lookalikeOf)} which you have paid before, but it is a different address. Wallets hide the middle, so the two are indistinguishable.`,
      lookalikeOf,
    });
  }

  const exactMatch = input.counterparties.some(
    (known) => normalise(known) === normalise(input.target),
  );

  // Rule (b): no history, or history that started in the last 24 hours. A
  // poisoning address is minted for the attack, so it is almost always brand new.
  if (input.targetActivity.transactionCount === 0 && input.targetActivity.firstSeenAt === null) {
    reasons.push({
      code: 'NEW_ADDRESS',
      severity: 'warning',
      message:
        'This address has no on-chain history. Normal for a new recipient; stop if you did not expect it.',
    });
  } else if (
    input.targetActivity.firstSeenAt !== null &&
    now.getTime() - input.targetActivity.firstSeenAt.getTime() < FRESH_ADDRESS_MAX_AGE_MS
  ) {
    reasons.push({
      code: 'FRESH_ADDRESS',
      severity: 'warning',
      message:
        'This address is less than 24 hours old. Poisoning addresses are minted fresh for the attack.',
    });
  }

  // Positive signals. They never override a block: an address you paid last week
  // does not make its lookalike safe.
  if (input.isVerifiedRecipient) {
    reasons.push({
      code: 'VERIFIED_RECIPIENT',
      severity: 'safe',
      message: 'A protected transfer to this address settled before, claimed with a code.',
    });
  } else if (exactMatch) {
    reasons.push({
      code: 'KNOWN_COUNTERPARTY',
      severity: 'safe',
      message: 'You have paid this exact address before.',
    });
  }

  const unavailable = input.unavailable ?? [];
  if (unavailable.length > 0) {
    // Fail closed: if the sender's payment history could not be fetched, the
    // lookalike rule never ran, so a poisoning lookalike cannot be ruled out.
    // Unless the target is positively known-good (a verified/previously-paid
    // recipient), block rather than warn — refusing to send is the only real
    // protection, and a firewall that waves traffic through when its data source
    // is down is worse than none.
    const knownGood = input.isVerifiedRecipient || exactMatch;
    const lookalikeUncheckable = input.lookalikeCheckable === false;
    const severity: RiskLevel = lookalikeUncheckable && !knownGood ? 'block' : 'warning';
    reasons.push({
      code: 'DATA_UNAVAILABLE',
      severity,
      sources: unavailable,
      message:
        severity === 'block'
          ? `Blocked: your payment history could not be fetched (${unavailable.join(', ')}), so a lookalike of an address you trust cannot be ruled out. Try again, or verify the address out of band.`
          : `The risk check was incomplete (${unavailable.join(', ')} did not respond). We will not say "safe" without a full scan.`,
    });
  }

  const level = reasons.reduce<RiskLevel>(
    (worst, r) => (severityRank[r.severity] > severityRank[worst] ? r.severity : worst),
    'safe',
  );

  return {
    sender: input.sender,
    target: input.target,
    level,
    reasons,
    complete: unavailable.length === 0,
  };
}

function shorten(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
