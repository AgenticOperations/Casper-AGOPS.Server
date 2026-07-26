import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { keys } from '../../src/redis/keyspace.js';
import { reserveHoldWithinPolicy, settleHold } from '../../src/engines/ledger/window.js';

/**
 * Same contract as float-solvency.test.ts, but against a LOCAL redis on REDIS_TEST_URL instead of a
 * testcontainer. Exists because Docker's image store is corrupted on this machine, which makes the
 * containerised suites skip silently — a green run there proves nothing. This file is the fallback
 * that actually executes the Lua.
 *
 * Skips unless REDIS_TEST_URL is set, so it is inert in CI where the container suites are canonical.
 */

const URL = process.env.REDIS_TEST_URL;
let redis: Redis | undefined;

const AGENT = 'agt_solvency_local';
const TS = 1_000_000;
const CSPR = 1_000_000_000n;
const BIG_CAP = 1_000_000n * CSPR;

beforeAll(async () => {
  if (!URL) return;
  redis = new Redis(URL, { maxRetriesPerRequest: 3 });
});

afterAll(async () => {
  await redis?.quit();
});

beforeEach(async () => {
  if (redis) await redis.flushall();
});

const reserve = (over: Partial<Parameters<typeof reserveHoldWithinPolicy>[1]> = {}) => ({
  agentId: AGENT,
  paymentId: `pay_${Math.random().toString(16).slice(2)}`,
  amount: 3n * CSPR,
  enforcementTs: TS,
  spendCap: BIG_CAP,
  velocityLimitPerHour: 1000,
  enforceSolvency: true,
  ...over,
});

describe('spend-path float solvency [local redis]', () => {
  it('DENIES a payment when the agent holds no confirmed float', async ({ skip }) => {
    if (!redis) return skip();
    expect(await reserveHoldWithinPolicy(redis, reserve())).toBe('insufficient_float');
    expect(await redis.get(keys.reserved(AGENT))).toBeNull();
    expect(await redis.zcard(keys.spendWindow(AGENT, '1h'))).toBe(0);
  });

  it('ALLOWS a payment fully covered by confirmed float', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (10n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe('reserved');
    expect(await redis.get(keys.reserved(AGENT))).toBe((3n * CSPR).toString());
  });

  it('ALLOWS spending exactly the full spendable balance (inclusive boundary)', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (3n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe('reserved');
  });

  it('DENIES one mote over the spendable balance', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (3n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR + 1n }))).toBe(
      'insufficient_float',
    );
  });

  it('counts OUTSTANDING HOLDS against float', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (5n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe('reserved');
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe(
      'insufficient_float',
    );
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 2n * CSPR }))).toBe('reserved');
  });

  it('counts SETTLED spend (consumed) against float', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (5n * CSPR).toString());
    await redis.set(keys.consumed(AGENT), (4n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 2n * CSPR }))).toBe(
      'insufficient_float',
    );
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 1n * CSPR }))).toBe('reserved');
  });

  it('frees float for reuse once a hold settles out of the reserved counter', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (10n * CSPR).toString());
    const first = reserve({ amount: 6n * CSPR });
    expect(await reserveHoldWithinPolicy(redis, first)).toBe('reserved');
    await settleHold(redis, AGENT, first.paymentId);
    expect(await redis.get(keys.reserved(AGENT))).toBe('0');
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 10n * CSPR }))).toBe('reserved');
  });

  it('reports the SPEND CAP when a request breaches both cap and float', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (1n * CSPR).toString());
    expect(
      await reserveHoldWithinPolicy(redis, reserve({ amount: 5n * CSPR, spendCap: 2n * CSPR })),
    ).toBe('cap_exceeded');
  });

  it('never overspends float under concurrency', async ({ skip }) => {
    if (!redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (10n * CSPR).toString());
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveHoldWithinPolicy(redis!, reserve({ amount: 3n * CSPR }))),
    );
    expect(results.filter((r) => r === 'reserved').length).toBe(3);
    expect(BigInt((await redis.get(keys.reserved(AGENT))) ?? '0')).toBe(9n * CSPR);
  });

  it('is EXACT above 2^53 motes (string decimal, not Lua doubles)', async ({ skip }) => {
    if (!redis) return skip();
    const huge = 20_000_000n * CSPR;
    await redis.set(keys.floatConfirmed(AGENT), huge.toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: huge, spendCap: huge * 2n }))).toBe(
      'reserved',
    );
    await redis.flushall();
    await redis.set(keys.floatConfirmed(AGENT), (huge - 1n).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: huge, spendCap: huge * 2n }))).toBe(
      'insufficient_float',
    );
  });

  it('SKIPS the balance check when enforceSolvency is false', async ({ skip }) => {
    if (!redis) return skip();
    expect(await reserveHoldWithinPolicy(redis, reserve({ enforceSolvency: false }))).toBe('reserved');
  });

  it('still enforces the spend cap when solvency is skipped', async ({ skip }) => {
    if (!redis) return skip();
    expect(
      await reserveHoldWithinPolicy(
        redis,
        reserve({ enforceSolvency: false, amount: 5n * CSPR, spendCap: 2n * CSPR }),
      ),
    ).toBe('cap_exceeded');
  });
});
