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
  // Default: a well-funded org, so the pre-existing cases below keep testing the POLICY budget in
  // isolation. The solvency suite overrides this explicitly.
  fundedTotal: usdc(1_000_000),
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

/**
 * Solvency ceiling: agent float must be backed by CSPR the org actually deposited into the parent
 * treasury. Before this gate, `evaluateAllocation` compared only against `policy.totalBudget` — a
 * policy constant — so an org with ZERO deposits could still provision float up to that dial, handing
 * agents spending authority against money that never existed.
 */
describe('evaluateAllocation — treasury solvency ceiling (unfunded org cannot allocate float)', () => {
  it('DENIES any allocation when the org has never deposited (funded = 0)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // The reported bug, exactly: policy budget is a healthy 100, but nothing was ever deposited.
    const d = await evaluateAllocation(redis, req({ fundedTotal: 0n }));
    expect(d).toEqual({ allow: false, reason: 'treasury_insufficient_funds' });
    // An insolvent ask reserves nothing.
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('DENIES an allocation that exceeds real deposits even when well inside the policy budget', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // Deposited 10, policy allows 100, asking 30 → policy says yes, custody says no.
    const d = await evaluateAllocation(redis, req({ requested: usdc(30), fundedTotal: usdc(10) }));
    expect(d).toEqual({ allow: false, reason: 'treasury_insufficient_funds' });
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('ALLOWS an allocation fully covered by real deposits', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const d = await evaluateAllocation(redis, req({ requested: usdc(30), fundedTotal: usdc(30) }));
    expect(d).toEqual({ allow: true });
    expect(await redis.get(keys.allocationReserved(ORG))).toBe(usdc(30).toString());
  });

  it('counts already-outstanding allocations against the funded balance', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // 25 already committed against 30 deposited leaves 5 — a second 30 must be refused.
    await redis.set(keys.allocationCommitted(ORG), usdc(25).toString());
    const d = await evaluateAllocation(redis, req({ requested: usdc(30), fundedTotal: usdc(30) }));
    expect(d).toEqual({ allow: false, reason: 'treasury_insufficient_funds' });
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('reports the POLICY dial when a request breaches both ceilings', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // Over per_agent_max (40) AND over funded (10): the operator should be told the policy refused it,
    // since raising the budget is the action that would matter first.
    const d = await evaluateAllocation(redis, req({ requested: usdc(41), fundedTotal: usdc(10) }));
    expect(d).toEqual({ allow: false, reason: 'allocation_exceeded' });
    expect(await redis.get(keys.allocationReserved(ORG))).toBeNull();
  });

  it('never overdraws real deposits under concurrency (atomic, same TOCTOU class as BUG-19)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    // Deposited 50 with a policy budget of 100: the FUNDED bound is tighter, so only 1 of 10 concurrent
    // 30-unit asks may pass. A check-then-reserve split would let several through here.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        evaluateAllocation(redis!, req({ requested: usdc(30), fundedTotal: usdc(50) })),
      ),
    );
    expect(results.filter((r) => r.allow).length).toBe(1);
    const reserved = BigInt((await redis.get(keys.allocationReserved(ORG))) ?? '0');
    expect(reserved).toBe(usdc(30));
    expect(reserved).toBeLessThanOrEqual(usdc(50));
  });
});
