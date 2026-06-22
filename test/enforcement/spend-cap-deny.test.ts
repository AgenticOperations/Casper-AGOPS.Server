import { describe, it, expect } from 'vitest';
import { evaluateSpend, type SpendEvalInput } from '../../src/engines/enforcement/spend-eval.js';
import type { SpendPolicy } from '../../src/contracts/index.js';

/**
 * The SpendCap gate (policy-engine-FINAL.md:108, engine-specs-FINAL.md:127): consumed + amount ≤ cap
 * in EVERY window, and utilization is HOLD-INCLUSIVE (committed = settled + outstanding holds), so an
 * agent cannot spam in-flight authorizations past the cap before any settle. Pure — the window sums are
 * supplied (E4 `windowSum` computes them on the live path).
 */

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

const policy: SpendPolicy = {
  spendCap: usdc(10),
  perTransactionMax: usdc(10),
  serviceScope: ['svc:forecast'],
  railPermission: ['circle-nano'],
  velocityLimitPerHour: 1000,
};

const base: SpendEvalInput = {
  policy,
  amount: usdc(3),
  railScheme: 'circle-nano',
  resourceId: 'svc:forecast',
  windowUtil: { '1h': 0n, '1d': 0n, '7d': 0n, '30d': 0n },
  velocityCount: 0,
};

describe('evaluateSpend — SpendCap (hold-inclusive, every window)', () => {
  it('allows when every window stays at or under the cap', () => {
    expect(evaluateSpend({ ...base, windowUtil: { '1h': usdc(2), '1d': usdc(5), '7d': usdc(6), '30d': usdc(7) } })).toEqual({
      allow: true,
    });
  });

  it('allows exactly at the cap (≤, not <)', () => {
    // util 7 + amount 3 == cap 10 in the binding window.
    expect(evaluateSpend({ ...base, windowUtil: { '1h': 0n, '1d': 0n, '7d': 0n, '30d': usdc(7) } })).toEqual({
      allow: true,
    });
  });

  it('denies when the longest window would exceed the cap', () => {
    // 30d already at 8; +3 = 11 > 10.
    expect(evaluateSpend({ ...base, windowUtil: { '1h': 0n, '1d': 0n, '7d': 0n, '30d': usdc(8) } })).toEqual({
      allow: false,
      reason: 'spend_cap_exceeded',
    });
  });

  it('denies on ANY single window breach even if the others have room', () => {
    // only the 1h window is over; the rest are clear — still a deny.
    expect(evaluateSpend({ ...base, windowUtil: { '1h': usdc(9), '1d': 0n, '7d': 0n, '30d': 0n } })).toEqual({
      allow: false,
      reason: 'spend_cap_exceeded',
    });
  });

  it('counts outstanding holds: a hold already in the window pushes the next request over', () => {
    // A $9 hold (not yet settled) is already counted in windowUtil; a $2 spend now breaches the cap.
    expect(evaluateSpend({ ...base, amount: usdc(2), windowUtil: { '1h': usdc(9), '1d': usdc(9), '7d': usdc(9), '30d': usdc(9) } })).toEqual({
      allow: false,
      reason: 'spend_cap_exceeded',
    });
  });
});
