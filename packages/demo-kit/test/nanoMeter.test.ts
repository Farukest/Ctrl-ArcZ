import { describe, expect, it } from 'vitest';
import { gaugeTone } from '../src/ui/NanoMeter.js';

describe('gaugeTone', () => {
  it('reads the fraction left', () => {
    expect(gaugeTone(0.9, 100)).toBe('ok');
    expect(gaugeTone(0.3, 100)).toBe('warn');
    expect(gaugeTone(0.1, 100)).toBe('critical');
  });

  it('turns critical when a handful of requests are left, whatever the fraction', () => {
    expect(gaugeTone(0.8, 3)).toBe('critical');
  });

  it('is empty with nothing to spend, and when nothing has been measured yet', () => {
    expect(gaugeTone(0, 0)).toBe('empty');
    expect(gaugeTone(0.5, 0)).toBe('empty');
    expect(gaugeTone(null, null)).toBe('empty');
  });
});
