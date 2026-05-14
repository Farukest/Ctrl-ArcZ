import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { defineConfig, recommendTransferMode, shouldBlockSend } from '../src/config/config.js';

const FEE_RECIPIENT = '0x2222222222222222222222222222222222222222' as Address;
const USDC = (whole: number) => BigInt(whole) * 1_000_000n;

describe('defineConfig', () => {
  it('defaults to a one-hour window, no fee, code claim', () => {
    const config = defineConfig();

    expect(config.recallWindow).toBe(3600);
    expect(config.claimMode).toBe('CODE');
    expect(config.feeBps).toBe(0);
    expect(config.minProtectedAmount).toBe(USDC(10));
    expect(config.onWarning).toBe('warn');
  });

  /** The exchange setup from the brief: a 24-hour window, block on warnings. */
  it('accepts an exchange-style config', () => {
    const config = defineConfig({
      recallWindow: 24 * 60 * 60,
      onWarning: 'block',
      minProtectedAmount: USDC(100),
    });

    expect(config.recallWindow).toBe(86_400);
    expect(config.onWarning).toBe('block');
  });

  /** The P2P setup: a 60-second window. */
  it('accepts a 60-second window', () => {
    expect(defineConfig({ recallWindow: 60 }).recallWindow).toBe(60);
  });

  it('rejects a window longer than the contract allows', () => {
    expect(() => defineConfig({ recallWindow: 8 * 24 * 60 * 60 })).toThrow(/7 days/);
  });

  it('rejects a fee above 1%', () => {
    expect(() => defineConfig({ feeBps: 101, feeRecipient: FEE_RECIPIENT })).toThrow(/between 0/);
  });

  it('rejects a fee with no recipient — the contract would revert anyway', () => {
    expect(() => defineConfig({ feeBps: 25 })).toThrow(/feeRecipient is required/);
  });

  it('rejects the claim modes that v1 does not implement', () => {
    expect(() => defineConfig({ claimMode: 'SIGNATURE' })).toThrow(/reserved/);
    expect(() => defineConfig({ claimMode: 'REGISTERED' })).toThrow(/reserved/);
  });

  it('rejects a negative window', () => {
    expect(() => defineConfig({ recallWindow: -1 })).toThrow(/non-negative/);
  });
});

describe('recommendTransferMode', () => {
  it('suggests a plain transfer below the threshold', () => {
    const config = defineConfig({ minProtectedAmount: USDC(10) });

    expect(recommendTransferMode(config, USDC(5))).toBe('plain');
    expect(recommendTransferMode(config, USDC(9))).toBe('plain');
  });

  it('protects at and above the threshold', () => {
    const config = defineConfig({ minProtectedAmount: USDC(10) });

    expect(recommendTransferMode(config, USDC(10))).toBe('protected');
    expect(recommendTransferMode(config, USDC(5000))).toBe('protected');
  });
});

describe('shouldBlockSend', () => {
  it('always stops on a block verdict, whatever the integrator prefers', () => {
    expect(shouldBlockSend(defineConfig({ onWarning: 'warn' }), 'block')).toBe(true);
    expect(shouldBlockSend(defineConfig({ onWarning: 'block' }), 'block')).toBe(true);
  });

  it('lets the integrator decide what a warning means', () => {
    expect(shouldBlockSend(defineConfig({ onWarning: 'warn' }), 'warning')).toBe(false);
    expect(shouldBlockSend(defineConfig({ onWarning: 'block' }), 'warning')).toBe(true);
  });

  it('never stops a safe send', () => {
    expect(shouldBlockSend(defineConfig({ onWarning: 'block' }), 'safe')).toBe(false);
  });
});
