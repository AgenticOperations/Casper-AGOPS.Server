import { describe, it, expect } from 'vitest';
import { computeSpendable } from '../../src/engines/custody/balance.js';

/**
 * Thesis claim: two-phase float — spendable = confirmed − consumed − reserved − escrow_reserved;
 * pending float is never spendable (engine-specs-FINAL.md:178-179).
 */

describe('two-phase float: spendable excludes pending, consumed, reserved, escrow', () => {
  it('spendable = confirmed − consumed − reserved − escrow_reserved', () => {
    expect(
      computeSpendable({ floatConfirmed: 100n, consumed: 10n, reserved: 20n, escrowReserved: 5n }),
    ).toBe(65n);
  });

  it('counts only confirmed float (pending is not an input — never spendable)', () => {
    expect(
      computeSpendable({ floatConfirmed: 50n, consumed: 0n, reserved: 0n, escrowReserved: 0n }),
    ).toBe(50n);
  });

  it('clamps at zero — reserved/consumed beyond confirmed never goes negative', () => {
    expect(
      computeSpendable({ floatConfirmed: 10n, consumed: 0n, reserved: 20n, escrowReserved: 0n }),
    ).toBe(0n);
  });
});
