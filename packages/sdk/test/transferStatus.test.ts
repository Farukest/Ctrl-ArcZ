import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  isClaimable,
  isOpen,
  isReturnable,
  isTerminal,
  statusBucket,
  type ProtectedTransfer,
  type TransferStatus,
} from '../src/index.js';

/**
 * The gap between what the chain records and what a person can do about it.
 *
 * A transfer whose window has closed still reads PENDING, and every screen that
 * trusted the status alone counted it as something the recipient was waiting for.
 */

const SENDER = '0x46D060E22B84BFE396DF9CE61D5bA217ba6346C5' as Address;
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

function transfer(over: Partial<ProtectedTransfer> = {}): ProtectedTransfer {
  return {
    sender: SENDER,
    to: '0x64EaE81Ac7aE24355dA95d5BDd3BA66442E4Fe3F' as Address,
    amount: 100_000n,
    status: 'PENDING' as TransferStatus,
    deadline: new Date(NOW + 60_000),
    ...over,
  } as ProtectedTransfer;
}

describe('isTerminal / isOpen', () => {
  it('calls only the three settled statuses terminal', () => {
    for (const s of ['CLAIMED', 'CANCELLED', 'RECLAIMED'] as TransferStatus[]) {
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal('PENDING')).toBe(false);
    // Five wrong codes lock a transfer, but the sender can still cancel it and the
    // window can still lapse, so it is not an end.
    expect(isTerminal('LOCKED')).toBe(false);
  });

  it('counts PENDING and LOCKED as open', () => {
    expect(isOpen('PENDING')).toBe(true);
    expect(isOpen('LOCKED')).toBe(true);
    expect(isOpen('CLAIMED')).toBe(false);
    expect(isOpen('RECLAIMED')).toBe(false);
  });

  it('never calls the same status both open and terminal', () => {
    for (const s of ['PENDING', 'LOCKED', 'CLAIMED', 'CANCELLED', 'RECLAIMED'] as TransferStatus[]) {
      expect(isOpen(s) && isTerminal(s)).toBe(false);
    }
  });
});

describe('isClaimable', () => {
  it('accepts a pending transfer inside its window', () => {
    expect(isClaimable(transfer(), NOW)).toBe(true);
  });

  it('refuses one whose window has closed', () => {
    // The contract refuses this claim, so counting it as waiting offers a button
    // that spends gas to revert. It stays PENDING on the chain either way.
    expect(isClaimable(transfer({ deadline: new Date(NOW - 1) }), NOW)).toBe(false);
  });

  it('treats the deadline itself as closed', () => {
    expect(isClaimable(transfer({ deadline: new Date(NOW) }), NOW)).toBe(false);
  });

  it('refuses a locked transfer even inside its window', () => {
    expect(isClaimable(transfer({ status: 'LOCKED' }), NOW)).toBe(false);
  });

  it('refuses everything settled', () => {
    for (const status of ['CLAIMED', 'CANCELLED', 'RECLAIMED'] as TransferStatus[]) {
      expect(isClaimable(transfer({ status }), NOW)).toBe(false);
    }
  });
});

describe('isReturnable', () => {
  it('is the state no status pill names: open, but past its deadline', () => {
    expect(isReturnable(transfer({ deadline: new Date(NOW - 1) }), NOW)).toBe(true);
    expect(isReturnable(transfer({ status: 'LOCKED', deadline: new Date(NOW - 1) }), NOW)).toBe(
      true,
    );
  });

  it('is not offered while the recipient can still claim', () => {
    expect(isReturnable(transfer(), NOW)).toBe(false);
  });

  it('is not offered once somebody has already reclaimed it', () => {
    expect(isReturnable(transfer({ status: 'RECLAIMED', deadline: new Date(NOW - 1) }), NOW)).toBe(
      false,
    );
  });

  it('never overlaps with isClaimable', () => {
    for (const status of ['PENDING', 'LOCKED'] as TransferStatus[]) {
      for (const offset of [-1, 0, 1, 60_000]) {
        const t = transfer({ status, deadline: new Date(NOW + offset) });
        expect(isClaimable(t, NOW) && isReturnable(t, NOW)).toBe(false);
      }
    }
  });
});

describe('statusBucket', () => {
  it('files each status under the group a person sorts it into', () => {
    expect(statusBucket('CLAIMED')).toBe('claimed');
    expect(statusBucket('CANCELLED')).toBe('cancelled');
    expect(statusBucket('RECLAIMED')).toBe('expired');
    expect(statusBucket('PENDING')).toBe('pending');
  });

  it('keeps LOCKED with pending, where the money still is', () => {
    expect(statusBucket('LOCKED')).toBe('pending');
  });
});
