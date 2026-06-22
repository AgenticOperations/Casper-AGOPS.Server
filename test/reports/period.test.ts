import { describe, it, expect } from 'vitest';
import { resolvePeriod } from '../../src/engines/ledger/reports.js';

const NOW = new Date('2026-06-20T12:00:00.000Z');

describe('resolvePeriod', () => {
  it('defaults to 30d for undefined or unknown input', () => {
    expect(resolvePeriod(undefined, NOW).label).toBe('30d');
    expect(resolvePeriod('garbage', NOW).label).toBe('30d');
    expect(resolvePeriod('30d', NOW).from).toBe('2026-05-21T12:00:00.000Z');
  });

  it('resolves 7d to a seven-day window ending now', () => {
    const p = resolvePeriod('7d', NOW);
    expect(p.label).toBe('7d');
    expect(p.from).toBe('2026-06-13T12:00:00.000Z');
    expect(p.to).toBe('2026-06-20T12:00:00.000Z');
  });

  it('resolves all to an open-from-epoch window', () => {
    const p = resolvePeriod('all', NOW);
    expect(p.label).toBe('all');
    expect(p.from).toBe('1970-01-01T00:00:00.000Z');
    expect(p.to).toBe('2026-06-20T12:00:00.000Z');
  });
});
