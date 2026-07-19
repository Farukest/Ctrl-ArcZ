import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  sendProtected,
  MAX_REPORT_AGE_MS,
  type ClientPair,
  type SendProtectedParams,
} from '../src/transfer/transfer.js';
import { RiskBlockedError } from '../src/transfer/errors.js';
import { defineConfig } from '../src/config/config.js';
import { evaluateRisk } from '../src/risk/rules.js';
import type {
  AddressActivity,
  CounterpartyScan,
  IDataProvider,
  RiskReport,
} from '../src/risk/types.js';

const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const TARGET = '0x9999888877776666555544443333222211110000' as Address;
const OTHER = '0x4444444444444444444444444444444444444444' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** Minimal provider; each field defaults to a clean, long-standing recipient. */
class FakeProvider implements IDataProvider {
  calls = 0;
  constructor(
    private readonly data: {
      counterparties?: Address[];
      activity?: AddressActivity;
      zeroValue?: number;
    } = {},
  ) {}
  async getOutgoingCounterparties(): Promise<CounterpartyScan> {
    this.calls++;
    return { counterparties: this.data.counterparties ?? [], complete: true };
  }
  async getAddressActivity(): Promise<AddressActivity> {
    return this.data.activity ?? { transactionCount: 42, firstSeenAt: new Date('2025-01-01') };
  }
  async countZeroValueTransfers(): Promise<number> {
    return this.data.zeroValue ?? 0;
  }
}

/**
 * A client pair whose `writeContract` throws a sentinel: reaching it proves the
 * risk guard let the send through. The contract address is zero so `check`'s
 * on-chain reads short-circuit and only the injected provider is consulted.
 */
function stubClients(writeContract = vi.fn(async () => 'WRITE_REACHED' as never)): ClientPair {
  return {
    contractAddress: ZERO,
    publicClient: {} as ClientPair['publicClient'],
    walletClient: {
      account: { address: SENDER, type: 'json-rpc' },
      writeContract,
    } as unknown as ClientPair['walletClient'],
  };
}

/** Sentinel writer: reaching the chain throws, so the test can assert it got there. */
const reachesChain = () =>
  vi.fn(async () => {
    throw new Error('WRITE_REACHED');
  });

const PARAMS: SendProtectedParams = {
  configId: `0x${'0'.repeat(64)}`,
  to: TARGET,
  amount: 1_000_000n,
  claimHash: `0x${'1'.repeat(64)}`,
};

/** A clean, safe report for the given pair, stamped `checkedAt` ms ago. */
function reportFor(sender: Address, target: Address, ageMs = 0): RiskReport {
  const now = new Date(Date.now() - ageMs);
  return evaluateRisk(
    {
      sender,
      target,
      counterparties: [target],
      targetActivity: { transactionCount: 9, firstSeenAt: new Date('2025-01-01') },
      zeroValueBait: { count: 0 },
      isVerifiedRecipient: true,
      lookalikeCheckable: true,
    },
    now,
  );
}

describe('sendProtected built-in risk guard', () => {
  it('blocks a poisoning-baited recipient before any funds move', async () => {
    const write = vi.fn(async () => 'WRITE_REACHED' as never);

    await expect(
      sendProtected(stubClients(write), PARAMS, {
        checkOptions: { provider: new FakeProvider({ zeroValue: 1 }) },
      }),
    ).rejects.toBeInstanceOf(RiskBlockedError);
    expect(write).not.toHaveBeenCalled();
  });

  it('carries the whole report on the error, not just its messages', async () => {
    const error = await sendProtected(stubClients(), PARAMS, {
      checkOptions: { provider: new FakeProvider({ zeroValue: 1 }) },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RiskBlockedError);
    const blocked = error as RiskBlockedError;
    expect(blocked.report.level).toBe('block');
    expect(blocked.report.target.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(blocked.report.reasons.map((r) => r.code)).toContain('ZERO_VALUE_BAIT');
    // The flattened messages stay available for logging.
    expect(blocked.reasons.length).toBeGreaterThan(0);
  });

  it('skips the scan entirely with skipRiskCheck (integrator already gated)', async () => {
    const write = reachesChain();

    // The provider would block, but the guard is skipped, so we reach writeContract.
    await expect(
      sendProtected(stubClients(write), PARAMS, {
        skipRiskCheck: true,
        checkOptions: { provider: new FakeProvider({ zeroValue: 1 }) },
      }),
    ).rejects.toThrow('WRITE_REACHED');
    expect(write).toHaveBeenCalledOnce();
  });

  it('lets a warning through by default, and blocks it when the config says block', async () => {
    // A brand-new recipient is a `warning`, not a hard block.
    const newRecipient = () =>
      new FakeProvider({ activity: { transactionCount: 0, firstSeenAt: null } });

    const proceed = reachesChain();
    await expect(
      sendProtected(stubClients(proceed), PARAMS, {
        checkOptions: { provider: newRecipient() },
      }),
    ).rejects.toThrow('WRITE_REACHED');
    expect(proceed).toHaveBeenCalledOnce();

    const blocked = vi.fn(async () => 'WRITE_REACHED' as never);
    await expect(
      sendProtected(stubClients(blocked), PARAMS, {
        config: defineConfig({ onWarning: 'block' }),
        checkOptions: { provider: newRecipient() },
      }),
    ).rejects.toBeInstanceOf(RiskBlockedError);
    expect(blocked).not.toHaveBeenCalled();
  });

  it('reports the scan result via onReport when it does not block', async () => {
    const onReport = vi.fn();

    await expect(
      sendProtected(stubClients(reachesChain()), PARAMS, {
        onReport,
        checkOptions: { provider: new FakeProvider({ counterparties: [TARGET] }) },
      }),
    ).rejects.toThrow('WRITE_REACHED');
    expect(onReport).toHaveBeenCalledOnce();
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({ level: 'safe' });
  });

  it('reuses a fresh report for the same pair instead of scanning twice', async () => {
    const provider = new FakeProvider();

    await expect(
      sendProtected(stubClients(reachesChain()), PARAMS, {
        report: reportFor(SENDER, TARGET),
        checkOptions: { provider },
      }),
    ).rejects.toThrow('WRITE_REACHED');
    expect(provider.calls).toBe(0); // the supplied report was used, no second scan
  });

  it('re-scans when the supplied report is stale', async () => {
    // A stale report cannot prove anything: a bait could have landed since.
    const provider = new FakeProvider({ zeroValue: 1 });

    await expect(
      sendProtected(stubClients(), PARAMS, {
        report: reportFor(SENDER, TARGET, MAX_REPORT_AGE_MS + 1000),
        checkOptions: { provider },
      }),
    ).rejects.toBeInstanceOf(RiskBlockedError);
    expect(provider.calls).toBe(1);
  });

  it('re-scans when the supplied report is about a different target', async () => {
    // Otherwise a clean report for address A would wave through a send to poisoned B.
    const provider = new FakeProvider({ zeroValue: 1 });

    await expect(
      sendProtected(stubClients(), PARAMS, {
        report: reportFor(SENDER, OTHER),
        checkOptions: { provider },
      }),
    ).rejects.toBeInstanceOf(RiskBlockedError);
    expect(provider.calls).toBe(1);
  });
});
