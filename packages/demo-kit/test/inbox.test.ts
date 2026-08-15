import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { ProtectedTransfer, TransferStatus } from '@ctrl-arcz/sdk';
import {
  NO_ARRIVALS,
  nextArrival,
  receivedHaystack,
  relativeTime,
  statusTone,
} from '../src/ui/inbox.js';

/**
 * How the receiving side reads. Each of these was a few lines inside a component,
 * and the announcement rule in particular was wrong in a way only a dropped
 * connection revealed: a failed poll counted as an empty inbox, so the poll that
 * recovered announced month-old transfers as if they had just landed.
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

describe('statusTone', () => {
  it('separates the ends the recipient gains from the ones they lose', () => {
    expect(statusTone('CLAIMED')).toBe('ok');
    expect(statusTone('CANCELLED')).toBe('err');
    // Refunded to the sender: the recipient is not getting it, and the row must
    // not read like one that is still waiting.
    expect(statusTone('RECLAIMED')).toBe('err');
    expect(statusTone('LOCKED')).toBe('warn');
    expect(statusTone('PENDING')).toBe('idle');
  });
});

describe('relativeTime', () => {
  it('never says zero', () => {
    expect(relativeTime(NOW, NOW)).toBe('1s');
  });

  it('steps up a unit at a time', () => {
    expect(relativeTime(NOW - 45_000, NOW)).toBe('45s');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe('4d');
  });

  // Rounding claimed more time had passed than had. A transfer sent 2 days and 14
  // hours ago read "3d" while sitting under a date header two days old, and the
  // number beside a transfer is how long its claim window has been running.
  it('never runs ahead of the clock', () => {
    expect(relativeTime(NOW - (2 * 86_400_000 + 14 * 3_600_000), NOW)).toBe('2d');
    expect(relativeTime(NOW - 36 * 3_600_000, NOW)).toBe('1d');
    expect(relativeTime(NOW - 95 * 60_000, NOW)).toBe('1h');
    expect(relativeTime(NOW - 119_000, NOW)).toBe('1m');
  });

  // Each unit has to hand over only once it is genuinely full, or the label skips
  // from "59m" to "2h".
  it('hands over at the boundary, not before', () => {
    expect(relativeTime(NOW - 59_999, NOW)).toBe('59s');
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1m');
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59m');
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('1h');
    expect(relativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23h');
    expect(relativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1d');
  });
});

describe('receivedHaystack', () => {
  it('matches an amount, a sender, an id and a status from one box', () => {
    const hay = receivedHaystack({ transferId: 77n, transfer: transfer({ amount: 120_000n }) });
    expect(hay).toContain('77');
    expect(hay).toContain('0.12');
    expect(hay).toContain('usdc');
    expect(hay).toContain(SENDER.toLowerCase());
    expect(hay).toContain('pending');
  });

  it('is lowercased, so a pasted checksummed address still matches', () => {
    const hay = receivedHaystack({ transferId: 1n, transfer: transfer() });
    expect(hay).toBe(hay.toLowerCase());
  });
});

describe('nextArrival', () => {
  it('stays quiet on the first reading', () => {
    // Opening the app with three transfers waiting is not three arrivals.
    const step = nextArrival(NO_ARRIVALS, [1, 2, 3]);
    expect(step.announce).toBe(false);
    expect(step.state).toEqual({ seeded: true, count: 3 });
  });

  it('announces an increase after that', () => {
    const seeded = nextArrival(NO_ARRIVALS, [1]).state;
    expect(nextArrival(seeded, [1, 2]).announce).toBe(true);
  });

  it('says nothing when the count holds', () => {
    const seeded = nextArrival(NO_ARRIVALS, [1, 2]).state;
    expect(nextArrival(seeded, [1, 2]).announce).toBe(false);
  });

  it('says nothing when a claim takes the count down', () => {
    const seeded = nextArrival(NO_ARRIVALS, [1, 2]).state;
    expect(nextArrival(seeded, [1]).announce).toBe(false);
  });

  it('ignores a failed read instead of treating it as an empty inbox', () => {
    // This is the whole point of the null. A poll that could not reach the chain
    // used to write zero, and the poll that recovered announced everything that
    // had been sitting there for an hour.
    const seeded = nextArrival(NO_ARRIVALS, [1, 2, 3]).state;
    const blip = nextArrival(seeded, null);
    expect(blip.announce).toBe(false);
    expect(blip.state).toEqual(seeded);
    expect(nextArrival(blip.state, [1, 2, 3]).announce).toBe(false);
  });

  it('stays quiet through a whole outage and back', () => {
    let state = nextArrival(NO_ARRIVALS, [1, 2, 3]).state;
    for (let i = 0; i < 5; i++) {
      const step = nextArrival(state, null);
      expect(step.announce).toBe(false);
      state = step.state;
    }
    expect(nextArrival(state, [1, 2, 3]).announce).toBe(false);
    // and a genuine arrival after the outage still lands
    expect(nextArrival(state, [1, 2, 3, 4]).announce).toBe(true);
  });

  it('re-seeds from scratch after a wallet change', () => {
    // The app resets to NO_ARRIVALS when the address changes; the new wallet's
    // first reading must be a baseline, not an announcement.
    expect(nextArrival(NO_ARRIVALS, [1, 2, 3, 4, 5]).announce).toBe(false);
  });
});
