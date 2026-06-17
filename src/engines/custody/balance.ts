import type { UsdcBaseUnits } from '../../contracts/index.js';

/**
 * Two-phase float balance model (BUG-29, engine-specs-FINAL.md:178-179).
 *
 * A submitted `depositFor` increments `floatPending` only; pending float is NEVER spendable.
 * Promotion `floatPending → floatConfirmed` happens only on on-chain finality (M3/M6). Spendable
 * is confirmed float minus what is already consumed, transiently reserved, or held in escrow.
 */

export interface FloatBalance {
  floatConfirmed: UsdcBaseUnits;
  floatPending: UsdcBaseUnits;
  consumed: UsdcBaseUnits;
  reserved: UsdcBaseUnits;
  escrowReserved: UsdcBaseUnits;
}

export function computeSpendable(b: {
  floatConfirmed: UsdcBaseUnits;
  consumed: UsdcBaseUnits;
  reserved: UsdcBaseUnits;
  escrowReserved: UsdcBaseUnits;
}): UsdcBaseUnits {
  const spendable = b.floatConfirmed - b.consumed - b.reserved - b.escrowReserved;
  return spendable > 0n ? spendable : 0n;
}
