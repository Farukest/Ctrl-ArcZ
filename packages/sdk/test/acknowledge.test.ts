import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  acknowledgementCovers,
  MAX_ACKNOWLEDGEMENT_AGE_MS,
  type RiskAcknowledgement,
  type RiskLevel,
  type RiskReason,
  type RiskReport,
  type RiskRuleCode,
} from '../src/index.js';

/**
 * The only way past a refusal, and the four ways it must not be stretchable.
 *
 * The escape hatch exists because a rule engine can be wrong about a real
 * payment. It is safe because it carries the verdict the user actually saw, so
 * it cannot be reused for another recipient, kept forever, or ridden through a
 * verdict worse than the one they agreed to.
 */

const SENDER = '0x46D060E22B84BFE396DF9CE61D5bA217ba6346C5' as Address;
const TARGET = '0x64EaE81Ac7aE24355dA95d5BDd3BA66442E4Fe3F' as Address;
const OTHER = '0xAfBb17a34Bde0A2E2f01f2A87597891D2A295ddB' as Address;
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

function reason(code: RiskRuleCode, severity: RiskLevel = 'block'): RiskReason {
  return { code, severity, message: code };
}

/** A decision taken at `at`, defaulting to the moment of the test. */
function ack(report: RiskReport, at: number = NOW): RiskAcknowledgement {
  return { report, at };
}

function report(over: Partial<RiskReport> = {}): RiskReport {
  return {
    sender: SENDER,
    target: TARGET,
    level: 'block',
    reasons: [reason('LOOKALIKE_ADDRESS')],
    complete: true,
    checkedAt: new Date(NOW),
    ...over,
  };
}

describe('acknowledgementCovers', () => {
  it('covers the verdict it was taken against', () => {
    expect(acknowledgementCovers(ack(report()), report(), NOW)).toBe(true);
  });

  it('is case-insensitive about addresses', () => {
    const ackReport = report({ sender: SENDER.toLowerCase() as Address });
    expect(acknowledgementCovers(ack(ackReport), report(), NOW)).toBe(true);
  });

  describe('cannot be moved to another payment', () => {
    it('rejects a different recipient', () => {
      // The whole failure mode this prevents: acknowledge a false positive once,
      // then have every later address inherit the permission.
      expect(acknowledgementCovers(ack(report()), report({ target: OTHER }), NOW)).toBe(false);
    });

    it('rejects a different sender', () => {
      expect(acknowledgementCovers(ack(report()), report({ sender: OTHER }), NOW)).toBe(false);
    });
  });

  describe('cannot be kept', () => {
    it('holds inside the window', () => {
      expect(
        acknowledgementCovers(ack(report(), NOW - MAX_ACKNOWLEDGEMENT_AGE_MS + 1_000), report(), NOW),
      ).toBe(true);
    });

    it('expires past it', () => {
      expect(
        acknowledgementCovers(ack(report(), NOW - MAX_ACKNOWLEDGEMENT_AGE_MS - 1), report(), NOW),
      ).toBe(false);
    });

    it('is timed from the decision, not from the scan behind it', () => {
      // A protected send registers a config and approves an allowance first, two
      // transactions with a wallet confirmation each, so the scan is always older
      // than the decision by the time the guard runs. Timing the window from
      // `checkedAt` made every real override expire before it could be used.
      const decidedNow = ack(report({ checkedAt: new Date(NOW - 10 * 60_000) }), NOW);
      expect(acknowledgementCovers(decidedNow, report(), NOW)).toBe(true);
    });
  });

  describe('cannot be ridden through a worse verdict', () => {
    it('rejects an escalation from warning to block', () => {
      const ackReport = report({ level: 'warning', reasons: [reason('NEW_ADDRESS', 'warning')] });
      const actual = report({
        level: 'block',
        reasons: [reason('NEW_ADDRESS', 'warning'), reason('LOOKALIKE_ADDRESS')],
      });
      expect(acknowledgementCovers(ack(ackReport), actual, NOW)).toBe(false);
    });

    it('rejects an escalation even when the reasons are unchanged', () => {
      // The same code can carry different weight: an incomplete scan is a warning
      // on its own and a block when it means a lookalike could not be ruled out.
      // Acknowledging the mild reading must not carry the severe one.
      const ackReport = report({ level: 'warning', reasons: [reason('DATA_UNAVAILABLE', 'warning')] });
      const actual = report({ level: 'block', reasons: [reason('DATA_UNAVAILABLE', 'block')] });
      expect(acknowledgementCovers(ack(ackReport), actual, NOW)).toBe(false);
    });

    it('accepts a de-escalation, since they agreed to worse', () => {
      const ackReport = report();
      const actual = report({ level: 'warning', reasons: [reason('LOOKALIKE_ADDRESS')] });
      expect(acknowledgementCovers(ack(ackReport), actual, NOW)).toBe(true);
    });
  });

  describe('cannot cover a reason the user never saw', () => {
    it('rejects a new reason at the same level', () => {
      // A verdict can gain a reason without changing level. Acknowledging "no
      // history" must not silently cover "and it baited you", which is the one
      // reason that means an attack rather than a new counterparty.
      const ackReport = report({ reasons: [reason('LOOKALIKE_ADDRESS')] });
      const actual = report({
        reasons: [reason('LOOKALIKE_ADDRESS'), reason('ZERO_VALUE_BAIT')],
      });
      expect(acknowledgementCovers(ack(ackReport), actual, NOW)).toBe(false);
    });

    it('accepts when the acknowledgement saw more than is now in force', () => {
      const ackReport = report({
        reasons: [reason('LOOKALIKE_ADDRESS'), reason('ZERO_VALUE_BAIT')],
      });
      const actual = report({ reasons: [reason('LOOKALIKE_ADDRESS')] });
      expect(acknowledgementCovers(ack(ackReport), actual, NOW)).toBe(true);
    });

    it('accepts an unchanged incomplete scan, which is the honest false positive', () => {
      // Nothing is known to be wrong here; a data source simply did not answer.
      // This is the case an override exists for most of all.
      const ackReport = report({ complete: false, reasons: [reason('DATA_UNAVAILABLE')] });
      const actual = report({ complete: false, reasons: [reason('DATA_UNAVAILABLE')] });
      expect(acknowledgementCovers(ack(ackReport), actual, NOW)).toBe(true);
    });
  });
});
