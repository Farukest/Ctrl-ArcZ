import { describe, expect, it } from 'vitest';
import { isArmed, type ArmingState } from '../src/ui/riskArming.js';

/**
 * The front door, as a truth table.
 *
 * Every screen that sends money used to decide this for itself, and the bridge's
 * version left out the two "still running" cases, which is the only combination
 * where a transfer can leave ahead of the verdict that would have stopped it.
 */

const clear: ArmingState = { idle: false, checking: false, investigating: false, blocked: false };

describe('isArmed', () => {
  it('arms when the address is clean and every check has answered', () => {
    expect(isArmed(clear)).toBe(true);
  });

  it('does not arm while the rules are running', () => {
    // No verdict yet is not the same as a good verdict.
    expect(isArmed({ ...clear, checking: true })).toBe(false);
  });

  it('does not arm while the investigator is running', () => {
    // The advisory may only tighten, which is worth nothing if the send can be
    // signed before it lands.
    expect(isArmed({ ...clear, investigating: true })).toBe(false);
  });

  it('does not arm on a block', () => {
    expect(isArmed({ ...clear, blocked: true })).toBe(false);
  });

  it('arms with nothing in the box, so a bridge to yourself still works', () => {
    // No recipient means no address to judge. The firewall has no opinion and
    // must not hold the button shut on the strength of it.
    expect(isArmed({ ...clear, idle: true })).toBe(true);
  });

  it('stays armed while idle even if stale flags are still set', () => {
    // Clearing the field mid-scan leaves the in-flight request's flags behind for
    // a tick. Nothing is being paid, so nothing should be gated.
    expect(isArmed({ idle: true, checking: true, investigating: true, blocked: false })).toBe(true);
  });

  it('refuses whenever any check is outstanding, in every combination', () => {
    for (const checking of [true, false]) {
      for (const investigating of [true, false]) {
        for (const blocked of [true, false]) {
          const armed = isArmed({ idle: false, checking, investigating, blocked });
          expect(armed).toBe(!checking && !investigating && !blocked);
        }
      }
    }
  });
});
