import { describe, it, expect } from 'vitest';
import { evaluateSpend, type SpendEvalInput } from '../../src/engines/enforcement/spend-eval.js';
import type { SpendPolicy } from '../../src/contracts/index.js';

/**
 * P3-A SpendPolicy evaluator (policy-engine-FINAL.md:103-109, engine-specs-FINAL.md:127). The checks
 * run in a fixed order and the engine DENIES BY DEFAULT — every gate must pass; the first miss returns
 * its reason_code. ServiceScope is an ALLOWLIST, so an empty scope permits nothing. Pure decision over
 * a captured policy snapshot + hold-inclusive window utilization; no container runtime.
 */

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

const basePolicy: SpendPolicy = {
  spendCap: usdc(10),
  perTransactionMax: usdc(5),
  serviceScope: ['https://api.vendor.test/v1/forecast'],
  railPermission: ['circle-nano'],
  velocityLimitPerHour: 3,
};

const baseInput: SpendEvalInput = {
  policy: basePolicy,
  amount: usdc(2),
  railScheme: 'circle-nano',
  resourceId: 'https://api.vendor.test/v1/forecast',
  windowUtil: { '1h': 0n, '1d': 0n, '7d': 0n, '30d': 0n },
  velocityCount: 0,
};

describe('evaluateSpend — ordered, deny-by-default', () => {
  it('allows a request that passes every gate', () => {
    expect(evaluateSpend(baseInput)).toEqual({ allow: true });
  });

  it('denies a rail that is not in railPermission (checked first)', () => {
    expect(evaluateSpend({ ...baseInput, railScheme: 'raw-x402' })).toEqual({
      allow: false,
      reason: 'rail_not_permitted',
    });
  });

  it('denies a resource outside the serviceScope allowlist', () => {
    expect(
      evaluateSpend({ ...baseInput, resourceId: 'https://evil.test/drain' }),
    ).toEqual({ allow: false, reason: 'service_not_allowed' });
  });

  it('denies everything when the serviceScope allowlist is empty (deny-by-default)', () => {
    expect(
      evaluateSpend({ ...baseInput, policy: { ...basePolicy, serviceScope: [] } }),
    ).toEqual({ allow: false, reason: 'service_not_allowed' });
  });

  it('denies when the velocity count has reached the per-hour limit', () => {
    expect(evaluateSpend({ ...baseInput, velocityCount: 3 })).toEqual({
      allow: false,
      reason: 'velocity_exceeded',
    });
  });

  it('denies a single transaction over per_transaction_max', () => {
    expect(evaluateSpend({ ...baseInput, amount: usdc(6) })).toEqual({
      allow: false,
      reason: 'per_transaction_max_exceeded',
    });
  });

  it('reports the FIRST failing gate when several would fail (rail before scope)', () => {
    expect(
      evaluateSpend({
        ...baseInput,
        railScheme: 'raw-x402',
        resourceId: 'https://evil.test/drain',
      }),
    ).toEqual({ allow: false, reason: 'rail_not_permitted' });
  });
});
