import { describe, it, expect } from 'vitest';
import { snapshotWindows } from '../../src/engines/ledger/window.js';

/**
 * Thesis (BUG-14, policy-engine-FINAL.md:241-249): the spend-window lower boundary is snapshotted
 * at QUOTED time as a floor (tumbling-bucket start) and carried through to settlement. A payment
 * quoted near a bucket boundary must keep deducting from the bucket it was quoted against, never
 * the bucket that happens to be current when it finally settles.
 *
 * Pure — no container required.
 */

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

describe('window snapshot at QUOTED (BUG-14)', () => {
  it('floors each window to its tumbling-bucket start at quote time', () => {
    const quotedAt = 5 * DAY + 23 * HOUR + 3599; // 23:59:59 on day 5
    const snap = snapshotWindows(quotedAt);

    expect(snap['1h']).toBe(5 * DAY + 23 * HOUR); // start of the 23:00 hour
    expect(snap['1d']).toBe(5 * DAY); // 00:00:00 on day 5
    expect(snap['7d']).toBe(Math.floor(quotedAt / (7 * DAY)) * 7 * DAY);
    expect(snap['30d']).toBe(Math.floor(quotedAt / (30 * DAY)) * 30 * DAY);
  });

  it('keeps the day-N bucket even when the payment settles after rollover', () => {
    const quotedAt = 5 * DAY + DAY - 1; // 23:59:59 on day 5
    const settledAt = 6 * DAY + 5; // 00:00:05 on day 6 — bucket has rolled over

    const atQuote = snapshotWindows(quotedAt);
    const atSettle = snapshotWindows(settledAt);

    // Recomputing the boundary at settlement would wrongly move the deduction into the day-6 bucket.
    expect(atSettle['1d']).toBe(6 * DAY);
    expect(atQuote['1d']).toBe(5 * DAY);
    expect(atQuote['1d']).not.toBe(atSettle['1d']);
    // The system must deduct against `atQuote` (the snapshot), pinning the hold to the day-5 bucket.
  });
});
