import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { keys } from '../../src/redis/keyspace.js';
import { reserveHold, settleHold, releaseHold, windowSum } from '../../src/engines/ledger/window.js';

/**
 * Thesis (engine-specs-FINAL.md:153): a hold converts in place on SETTLED and is dropped only on
 * FAILED_TERMINAL / EXPIRED.
 *  - release  → the hold never happened: gone from every window AND the reserved counter.
 *  - settle   → the spend is real: it STAYS counted in the window (committed = settled + holds),
 *               but it is no longer outstanding-reserved, so the reserved counter drops.
 * Both are idempotent: the reserved counter is decremented exactly once.
 *
 * Requires Docker; skips when no container runtime is available.
 */

let container: StartedTestContainer | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

const TS = 2_000_000;

beforeAll(async () => {
  try {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: 3,
    });
  } catch {
    dockerAvailable = false;
  }
}, 180_000);

afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

describe('hold release vs settle convert-in-place (engine-specs-FINAL.md:153)', () => {
  it('release removes the hold from every window and the reserved counter', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const agent = 'agt_release';

    await reserveHold(redis, { agentId: agent, paymentId: 'pay_r', amount: 4_000_000n, enforcementTs: TS });
    expect(await windowSum(redis, agent, '1h', TS - 1)).toBe(4_000_000n);
    expect(await redis.get(keys.reserved(agent))).toBe('4000000');

    const released = await releaseHold(redis, agent, 'pay_r');
    expect(released).toBe(true);
    expect(await windowSum(redis, agent, '1h', TS - 1)).toBe(0n);
    expect(await windowSum(redis, agent, '30d', TS - 1)).toBe(0n);
    expect(await redis.get(keys.reserved(agent))).toBe('0');

    // Idempotent: a second release is a no-op, the reserved counter does not go negative.
    expect(await releaseHold(redis, agent, 'pay_r')).toBe(false);
    expect(await redis.get(keys.reserved(agent))).toBe('0');
  });

  it('settle keeps the spend counted in the window but clears it from reserved', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const agent = 'agt_settle';

    await reserveHold(redis, { agentId: agent, paymentId: 'pay_s', amount: 6_000_000n, enforcementTs: TS });

    const settled = await settleHold(redis, agent, 'pay_s');
    expect(settled).toBe(true);
    // convert-in-place: still counted by the window (committed = settled + holds)...
    expect(await windowSum(redis, agent, '1h', TS - 1)).toBe(6_000_000n);
    // ...but no longer outstanding-reserved.
    expect(await redis.get(keys.reserved(agent))).toBe('0');

    // Idempotent: a second settle does not double-decrement, window unchanged.
    expect(await settleHold(redis, agent, 'pay_s')).toBe(false);
    expect(await windowSum(redis, agent, '1h', TS - 1)).toBe(6_000_000n);
    expect(await redis.get(keys.reserved(agent))).toBe('0');
  });

  it('refuses to un-count a settled spend if release fires after settle (defense-in-depth)', async ({
    skip,
  }) => {
    if (!dockerAvailable || !redis) return skip();
    const agent = 'agt_settle_then_release';

    await reserveHold(redis, { agentId: agent, paymentId: 'pay_x', amount: 9_000_000n, enforcementTs: TS });
    await settleHold(redis, agent, 'pay_x');
    expect(await windowSum(redis, agent, '1h', TS - 1)).toBe(9_000_000n);
    expect(await redis.get(keys.reserved(agent))).toBe('0');

    // The FSM never releases a settled payment, but the money layer must not corrupt the window
    // if it ever happens: release is a no-op and the settled spend STAYS counted (BUG-14).
    const released = await releaseHold(redis, agent, 'pay_x');
    expect(released).toBe(false);
    expect(await windowSum(redis, agent, '1h', TS - 1)).toBe(9_000_000n);
    expect(await redis.get(keys.reserved(agent))).toBe('0');
  });
});
