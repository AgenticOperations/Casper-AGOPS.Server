import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { keys } from '../../src/redis/keyspace.js';
import { reserveHoldWithinPolicy, settleHold } from '../../src/engines/ledger/window.js';

/**
 * Float solvency on the SPEND path.
 *
 * The bug this closes: `reserveHoldWithinPolicy` checked only `spendCap` — a POLICY DIAL, not money —
 * and never read the agent's balance. An agent holding ZERO confirmed float could therefore authorize
 * an x402 payment, receive a real signature, and get paid data back from the vendor, because the
 * signature (not a balance) is what unlocks the service. Authorization was fully decoupled from
 * solvency.
 *
 * The rule now enforced, atomically alongside the cap:
 *     spendable = float_confirmed − consumed − reserved
 *
 * Requires Docker; skips when no container runtime is available.
 */

let container: StartedTestContainer | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

const AGENT = 'agt_solvency';
const TS = 1_000_000;
const CSPR = 1_000_000_000n;

/** A generous cap, so the SPEND CAP is never the binding constraint in this suite. */
const BIG_CAP = 1_000_000n * CSPR;

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

describe('spend-path float solvency (an unfunded agent cannot buy data)', () => {
  it('DENIES a payment when the agent holds no confirmed float', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // The reported bug, exactly: healthy cap, zero float, agent still got served.
    const r = await reserveHoldWithinPolicy(redis, reserve());
    expect(r).toBe('insufficient_float');
    // An insolvent request writes nothing: no hold, no window entry, no counter movement.
    expect(await redis.get(keys.reserved(AGENT))).toBeNull();
    expect(await redis.zcard(keys.spendWindow(AGENT, '1h'))).toBe(0);
  });

  it('ALLOWS a payment fully covered by confirmed float', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (10n * CSPR).toString());
    const r = await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }));
    expect(r).toBe('reserved');
    expect(await redis.get(keys.reserved(AGENT))).toBe((3n * CSPR).toString());
  });

  it('ALLOWS spending exactly the full spendable balance (inclusive boundary)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (3n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe('reserved');
  });

  it('DENIES one mote over the spendable balance', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (3n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR + 1n }))).toBe(
      'insufficient_float',
    );
  });

  it('counts OUTSTANDING HOLDS against float — a second payment cannot reuse the same balance', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (5n * CSPR).toString());
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe('reserved');
    // 3 of 5 is held; a second 3 must fail even though the first never settled.
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 3n * CSPR }))).toBe(
      'insufficient_float',
    );
    // The remainder is still spendable.
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 2n * CSPR }))).toBe('reserved');
  });

  it('counts SETTLED spend (consumed) against float', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (5n * CSPR).toString());
    await redis.set(keys.consumed(AGENT), (4n * CSPR).toString());
    // Only 1 CSPR of the 5 remains unspent.
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 2n * CSPR }))).toBe(
      'insufficient_float',
    );
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 1n * CSPR }))).toBe('reserved');
  });

  it('frees float for reuse once a hold settles out of the reserved counter', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (10n * CSPR).toString());
    const first = reserve({ amount: 6n * CSPR });
    expect(await reserveHoldWithinPolicy(redis, first)).toBe('reserved');
    // settleHold clears the reserved contribution; `consumed` is a separate settlement-path counter,
    // so post-settle the reserved leg no longer blocks the remaining balance.
    await settleHold(redis, AGENT, first.paymentId);
    expect(await redis.get(keys.reserved(AGENT))).toBe('0');
    expect(await reserveHoldWithinPolicy(redis, reserve({ amount: 10n * CSPR }))).toBe('reserved');
  });

  it('reports the SPEND CAP when a request breaches both cap and float', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.floatConfirmed(AGENT), (1n * CSPR).toString());
    // Over the 2-CSPR cap AND over the 1-CSPR float: the cap is reported, since it is the dial the
    // operator controls directly.
    const r = await reserveHoldWithinPolicy(
      redis,
      reserve({ amount: 5n * CSPR, spendCap: 2n * CSPR }),
    );
    expect(r).toBe('cap_exceeded');
  });

  it('never overspends float under concurrency (atomic, same TOCTOU class as the cap)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // 10 CSPR of float, ten concurrent 3-CSPR payments → at most 3 may pass (9 ≤ 10).
    await redis.set(keys.floatConfirmed(AGENT), (10n * CSPR).toString());
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveHoldWithinPolicy(redis!, reserve({ amount: 3n * CSPR }))),
    );
    expect(results.filter((r) => r === 'reserved').length).toBe(3);
    const held = BigInt((await redis.get(keys.reserved(AGENT))) ?? '0');
    expect(held).toBe(9n * CSPR);
    expect(held).toBeLessThanOrEqual(10n * CSPR);
  });

  it('is EXACT above 2^53 motes (string decimal arithmetic, not Lua doubles)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // 2^53 ≈ 9.007e15 motes. Float one mote above the request must allow; one below must deny.
    const huge = 20_000_000n * CSPR; // 2e16 motes, comfortably past double precision
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

  it('SKIPS the balance check when enforceSolvency is false (non-float-backed rails)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // casper-deploy is gas paid by the operator, not from agent float — zero float must still pass.
    const r = await reserveHoldWithinPolicy(redis, reserve({ enforceSolvency: false }));
    expect(r).toBe('reserved');
  });

  it('still enforces the spend cap when solvency is skipped', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const r = await reserveHoldWithinPolicy(
      redis,
      reserve({ enforceSolvency: false, amount: 5n * CSPR, spendCap: 2n * CSPR }),
    );
    expect(r).toBe('cap_exceeded');
  });
});
