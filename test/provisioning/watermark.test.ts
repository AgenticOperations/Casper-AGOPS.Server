import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeWatermark, needsReplenish } from '../../src/engines/provisioning/watermark.js';
import { reserveHold } from '../../src/engines/ledger/window.js';
import { startStores, stopStores, seedAgent, usdc, type Stores } from '../helpers/oracle-harness.js';

/**
 * E5 dynamic replenishment watermark (policy-engine-FINAL.md:178, NFR-05, SPIKE-02). The watermark is
 * `max(STATIC_FLOOR, P × recent_burn)`, where recent_burn is the agent's hold-inclusive spend over the
 * last window (the P4 spend ZSET, read via `windowSum`). A high-velocity agent earns a higher watermark so
 * replenishment fires before it runs dry — no threshold stutter. `STATIC_FLOOR` and `P` are PARAMS,
 * deliberately NOT frozen as code constants: SPIKE-02 calibrates them against simulated workload and
 * records the values in `spike-results.md`. These tests encode the calibration scenarios. Requires Docker.
 */

const NOW = 1_750_000_000;

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('dynamic watermark — max(floor, P × recent burn) (E5/L6, NFR-05)', () => {
  it('an idle agent floors at STATIC_FLOOR (no recent burn → the floor dominates)', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { agentId } = await seedAgent(pool, redis, 10);

    const watermark = await computeWatermark(redis, {
      agentId,
      now: NOW,
      staticFloor: usdc(10),
      multiplier: 2,
    });
    expect(watermark).toBe(usdc(10)); // 2 × $0 burn = $0 < floor → the floor wins.
    expect(needsReplenish(usdc(5), watermark)).toBe(true); // below the watermark → replenish.
    expect(needsReplenish(usdc(10), watermark)).toBe(false); // exactly at the watermark → no.
    expect(needsReplenish(usdc(20), watermark)).toBe(false); // above → no.
  });

  it('a high-velocity agent earns a watermark above the floor (P × burn dominates)', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { agentId } = await seedAgent(pool, redis, 10);

    // $30 of recent spend within the last hour, via the real hold-inclusive ZSET path.
    await reserveHold(redis, { agentId, paymentId: 'pay_a', amount: usdc(20), enforcementTs: NOW - 60 });
    await reserveHold(redis, { agentId, paymentId: 'pay_b', amount: usdc(10), enforcementTs: NOW - 120 });

    const watermark = await computeWatermark(redis, {
      agentId,
      now: NOW,
      staticFloor: usdc(10),
      multiplier: 2,
    });
    expect(watermark).toBe(usdc(60)); // max($10, 2 × $30) = $60.
    // A $50 balance is well above the floor but BELOW the dynamic watermark → replenish (no stutter).
    expect(needsReplenish(usdc(50), watermark)).toBe(true);
    expect(needsReplenish(usdc(60), watermark)).toBe(false);
  });

  it('applies a fractional multiplier exactly on base units (P = 1.5×, no float on money)', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { agentId } = await seedAgent(pool, redis, 10);

    await reserveHold(redis, { agentId, paymentId: 'pay_c', amount: usdc(20), enforcementTs: NOW - 30 });

    const watermark = await computeWatermark(redis, {
      agentId,
      now: NOW,
      staticFloor: usdc(10),
      multiplier: 1.5,
    });
    expect(watermark).toBe(usdc(30)); // max($10, 1.5 × $20) = $30, exact base-unit integer math.
  });

  it('only counts burn inside the window — an old spend does not raise the watermark', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { agentId } = await seedAgent(pool, redis, 10);

    // A $40 spend two hours ago is outside the 1h burn window → excluded by the windowed read.
    await reserveHold(redis, { agentId, paymentId: 'pay_old', amount: usdc(40), enforcementTs: NOW - 7200 });

    const watermark = await computeWatermark(redis, {
      agentId,
      now: NOW,
      staticFloor: usdc(10),
      multiplier: 2,
      window: '1h',
    });
    expect(watermark).toBe(usdc(10)); // old burn excluded → the floor dominates.
  });
});
