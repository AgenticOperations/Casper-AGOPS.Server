import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { keys } from '../../src/redis/keyspace.js';
import { reserveHold, windowSum } from '../../src/engines/ledger/window.js';

/**
 * Thesis (BUG-14, policy-engine-FINAL.md:234-239): a RESERVED hold counts against the spend
 * window the instant it is written — committed = SETTLED + outstanding holds. Reserve is one
 * atomic Lua across the window ZSETs, the amounts hash, and the reserved counter
 * (engine-specs-FINAL.md:128), and is idempotent on replay (the reserved counter is never
 * double-bumped).
 *
 * Requires Docker; skips when no container runtime is available.
 */

let container: StartedTestContainer | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

const AGENT = 'agt_l3';
const TS = 1_000_000; // arbitrary enforcement timestamp (the QUOTED window snapshot)

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

describe('hold-inclusive spend window (BUG-14)', () => {
  it('counts a RESERVED hold immediately and tracks the reserved counter', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();

    const fresh = await reserveHold(redis, {
      agentId: AGENT,
      paymentId: 'pay_1',
      amount: 5_000_000n,
      enforcementTs: TS,
    });
    expect(fresh).toBe(true);

    // hold-inclusive: visible in the 1h window the instant it is reserved, before any settlement.
    expect(await windowSum(redis, AGENT, '1h', TS - 1)).toBe(5_000_000n);
    // the same hold lives in every window (1d / 7d / 30d) too.
    expect(await windowSum(redis, AGENT, '30d', TS - 1)).toBe(5_000_000n);
    // the reserved counter (the custody spendable subtrahend) reflects it.
    expect(await redis.get(keys.reserved(AGENT))).toBe('5000000');
  });

  it('sums multiple holds and is idempotent on replay', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();

    await reserveHold(redis, {
      agentId: AGENT,
      paymentId: 'pay_2',
      amount: 3_000_000n,
      enforcementTs: TS + 1,
    });
    expect(await windowSum(redis, AGENT, '1h', TS - 1)).toBe(8_000_000n);

    // Replaying pay_1 must NOT double-count the reserved counter or the window sum.
    const replay = await reserveHold(redis, {
      agentId: AGENT,
      paymentId: 'pay_1',
      amount: 5_000_000n,
      enforcementTs: TS,
    });
    expect(replay).toBe(false);
    expect(await windowSum(redis, AGENT, '1h', TS - 1)).toBe(8_000_000n);
    expect(await redis.get(keys.reserved(AGENT))).toBe('8000000');
  });
});
