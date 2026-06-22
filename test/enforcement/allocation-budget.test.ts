import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { keys } from '../../src/redis/keyspace.js';
import { evaluateAllocation } from '../../src/engines/enforcement/allocation-eval.js';
import type { AllocationPolicy } from '../../src/contracts/index.js';

/**
 * P3-B AllocationPolicy (engine-specs-FINAL.md:128, policy-engine-FINAL.md:253-262). Two money-critical
 * invariants: (1) the org kill-switch `deny_all` is the FIRST gate — a suspended org reserves nothing;
 * (2) the budget reserve is ATOMIC (BUG-19) — `available = total − committed − reserved` is checked
 * and `reserved` is incremented in ONE Lua script, so N concurrent requests can never oversubscribe the
 * total budget. Requires Docker; skips when no container runtime is available.
 */

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;
const ORG = 'org_alloc_test';

const policy: AllocationPolicy = {
  totalBudget: usdc(100),
  perAgentMax: usdc(40),
  cooldownSeconds: 0,
  allowedDestinations: ['agt_child_1', 'agt_child_2'],
};

let redisc: StartedTestContainer | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

beforeAll(async () => {
  try {
    redisc = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    redis = new Redis({ host: redisc.getHost(), port: redisc.getMappedPort(6379), maxRetriesPerRequest: 3 });
  } catch {
    dockerAvailable = false;
  }
}, 180_000);

afterAll(async () => {
  await redis?.quit();
  await redisc?.stop();
});

beforeEach(async () => {
  if (redis) await redis.flushall();
});

const req = (over: Partial<Parameters<typeof evaluateAllocation>[1]> = {}) => ({
  orgId: ORG,
  requested: usdc(30),
  destination: 'agt_child_1',
  secondsSinceLastAllocation: null,
  policy,
  ...over,
});

describe('evaluateAllocation — deny_all first, atomic budget reserve (BUG-19)', () => {
  it('reserves within budget and bumps allocation_reserved', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const d = await evaluateAllocation(redis, req());
    expect(d).toEqual({ allow: true });
    expect(await redis.get(keys.allocationReserved(ORG))).toBe(usdc(30).toString());
  });

  it('accounts for already-committed budget: available = total − committed − reserved', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.allocationCommitted(ORG), usdc(80).toString());
    // 80 committed + 30 requested = 110 > 100 total → reject.
    const d = await evaluateAllocation(redis, req());
    expect(d).toEqual({ allow: false, reason: 'allocation_exceeded' });
    // reserved must be untouched on a rejected reserve.
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('denies a suspended org FIRST, before any reserve (BUG-36)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await redis.set(keys.denyAll(ORG), '1');
    const d = await evaluateAllocation(redis, req());
    expect(d).toEqual({ allow: false, reason: 'org_suspended' });
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('denies a request over per_agent_max (no reserve taken)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const d = await evaluateAllocation(redis, req({ requested: usdc(41) }));
    expect(d).toEqual({ allow: false, reason: 'allocation_exceeded' });
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('denies a destination outside the own-agent fence', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const d = await evaluateAllocation(redis, req({ destination: '0xExternalVendor' }));
    expect(d).toEqual({ allow: false, reason: 'service_not_allowed' });
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('never oversubscribes the total budget under concurrency (BUG-19 atomic)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // total 100, each request 30 → at most 3 may succeed (90 ≤ 100); a 4th (120) must fail.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => evaluateAllocation(redis!, req({ requested: usdc(30) }))),
    );
    const allowed = results.filter((r) => r.allow).length;
    expect(allowed).toBe(3);
    const reserved = BigInt((await redis.get(keys.allocationReserved(ORG))) ?? '0');
    expect(reserved).toBe(usdc(90));
    expect(reserved).toBeLessThanOrEqual(policy.totalBudget);
  });
});
