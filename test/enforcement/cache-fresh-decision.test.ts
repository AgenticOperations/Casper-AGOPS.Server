import { describe, it, expect } from 'vitest';
import { isCacheFresh } from '../../src/engines/enforcement/policy-epoch-guard.js';
import type { EffectivePolicy } from '../../src/contracts/index.js';

/**
 * Thesis (NFR-03): the staleness decision — "is this cached blob fresh enough to authorize
 * against?" — is the money-critical line. A stale (lower-epoch, looser) blob served as fresh is an
 * overspend. This is a PURE unit test with NO container runtime, so the comparison is asserted on
 * every run even where Docker is unavailable and the integration tests skip.
 */

const blobAt = (epoch: number): EffectivePolicy => ({
  agentId: 'agt_x',
  orgId: 'org_x',
  policyId: 'policy_x@v1',
  policyEpoch: epoch,
  spend: {
    spendCap: 10_000_000n,
    perTransactionMax: 10_000_000n,
    serviceScope: ['svc:a'],
    railPermission: ['raw-x402'],
    velocityLimitPerHour: 10,
  },
  allocation: {
    totalBudget: 200_000_000n,
    perAgentMax: 10_000_000n,
    cooldownSeconds: 0,
    allowedDestinations: ['0xVendor'],
  },
});

describe('isCacheFresh — the money-critical staleness decision (NFR-03)', () => {
  it('serves a blob whose epoch equals the current epoch', () => {
    expect(isCacheFresh(blobAt(5), 5)).toBe(true);
  });

  it('serves a blob NEWER than a lagging counter (self-heal ahead of mirror)', () => {
    expect(isCacheFresh(blobAt(6), 5)).toBe(true);
  });

  it('REJECTS a stale blob whose epoch predates the current epoch', () => {
    expect(isCacheFresh(blobAt(4), 5)).toBe(false);
  });

  it('rejects when the blob is missing (cache miss)', () => {
    expect(isCacheFresh(null, 5)).toBe(false);
  });

  it('rejects when the current epoch is unknown (cold start, fail toward freshness)', () => {
    expect(isCacheFresh(blobAt(5), null)).toBe(false);
  });

  it('rejects when both are absent', () => {
    expect(isCacheFresh(null, null)).toBe(false);
  });

  it('rejects a stale blob even at epoch 0 vs a positive current', () => {
    expect(isCacheFresh(blobAt(0), 1)).toBe(false);
  });
});
