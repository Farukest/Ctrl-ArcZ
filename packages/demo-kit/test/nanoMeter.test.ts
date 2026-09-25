import { describe, expect, it } from 'vitest';
import { gaugeTone } from '../src/ui/NanoMeter.js';

describe('gaugeTone', () => {
  it('reads the fraction left', () => {
    expect(gaugeTone(0.9, 100)).toBe('ok');
    expect(gaugeTone(0.3, 100)).toBe('warn');
    expect(gaugeTone(0.1, 100)).toBe('critical');
  });

  it('never says critical over a gauge that reads full', () => {
    expect(gaugeTone(1, 4)).toBe('ok');
  });

  it('is empty with nothing to spend, and when nothing has been measured yet', () => {
    expect(gaugeTone(0, 0)).toBe('empty');
    expect(gaugeTone(0.5, 0)).toBe('empty');
    expect(gaugeTone(null, null)).toBe('empty');
  });
});
