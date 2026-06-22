import type { SpendWindow } from '../../redis/keyspace.js';

/**
 * The QUOTED-time floor boundary for each spend window (BUG-14, policy-engine-FINAL.md:241-249).
 *
 * Captured once when a payment is QUOTED and carried through to settlement, so a hold authorized
 * near a bucket boundary is always deducted from the window it was quoted against — never the
 * window that happens to be current at settlement time. Each value is a tumbling-bucket start
 * (Unix seconds), used as the lower bound of a `ZRANGEBYSCORE` over the per-window hold ZSET.
 */
export type WindowSnapshot = Record<SpendWindow, number>;
