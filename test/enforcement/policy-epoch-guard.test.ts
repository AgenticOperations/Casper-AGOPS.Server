import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { runMigrations } from '../../src/db/migrate.js';
import {
  assignPolicy,
  createOrg,
  createPolicyVersion,
  registerAgent,
} from '../../src/engines/control/store.js';
import { recompileAgentPolicy, readEffectivePolicy } from '../../src/engines/control/publish.js';
import { bumpOrgEpoch } from '../../src/engines/control/epoch.js';
import { resolveEffectivePolicy } from '../../src/engines/enforcement/policy-epoch-guard.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { AllocationPolicy, SpendPolicy } from '../../src/contracts/index.js';

/**
 * Thesis (NFR-03, PHASE-1-NFR-CHECKLIST.md:35-40 / doc 04 §3 M4): P3-A rejects an effective_policy
 * cache entry whose epoch predates the org's current epoch and performs a synchronous inline
 * recompile for that agent — under the hot-path budget (<500ms) — before deciding. A fresh blob is
 * served from cache with no recompile.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const RECOMPILE_BUDGET_MS = 500;

let pgc: StartedPostgreSqlContainer | undefined;
let redisc: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

const spendAt = (cap: number): SpendPolicy => ({
  spendCap: usdc(cap),
  perTransactionMax: usdc(cap),
  serviceScope: ['svc:a'],
  railPermission: ['raw-x402'],
  velocityLimitPerHour: 10,
});

const alloc: AllocationPolicy = {
  totalBudget: usdc(200),
  perAgentMax: usdc(10),
  cooldownSeconds: 0,
  allowedDestinations: ['0xVendor'],
};

beforeAll(async () => {
  try {
    pgc = await new PostgreSqlContainer('postgres:16-alpine').start();
    redisc = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    pool = new pg.Pool({ connectionString: pgc.getConnectionUri() });
    redis = new Redis({
      host: redisc.getHost(),
      port: redisc.getMappedPort(6379),
      maxRetriesPerRequest: 3,
    });
    await runMigrations(pool);
  } catch {
    dockerAvailable = false;
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await redis?.quit();
  await redisc?.stop();
  await pgc?.stop();
});

/** Seed an org with one agent and an org-scoped spend + allocation policy. */
async function seedOrgAgent(
  p: pg.Pool,
  spendCap: number,
): Promise<{ orgId: string; agentId: string; spendPolicyId: string }> {
  const org = await createOrg(p, { name: 'Acme', adminKeyHash: issueAdminKey().hash });
  const { agent } = await registerAgent(p, { orgId: org.id });
  const sp = await createPolicyVersion(p, { orgId: org.id, class: 'spend', rules: spendAt(spendCap) });
  const ap = await createPolicyVersion(p, { orgId: org.id, class: 'allocation', rules: alloc });
  await assignPolicy(p, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: sp.policyId, class: 'spend' });
  await assignPolicy(p, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: ap.policyId, class: 'allocation' });
  return { orgId: org.id, agentId: agent.id, spendPolicyId: sp.policyId };
}

describe('P3-A policy-epoch guard (NFR-03)', () => {
  it('serves a fresh blob from cache without recompiling', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const { orgId, agentId } = await seedOrgAgent(pool, 10);

    // Compile + publish the blob, then mirror the current epoch to the Redis counter.
    const eff = await recompileAgentPolicy(pool, redis, agentId);
    await bumpOrgEpoch(redis, orgId, eff.policyEpoch);

    const res = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
    expect(res.recompiled).toBe(false);
    expect(res.policy.spend.spendCap).toBe(usdc(10));
    expect(res.policy.policyEpoch).toBe(eff.policyEpoch);
  });

  it('rejects a stale-epoch blob, recompiles inline under budget, and decides on the new version', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const { orgId, agentId, spendPolicyId } = await seedOrgAgent(pool, 10);

    // Propagate the original policy into the cache + counter.
    const v1 = await recompileAgentPolicy(pool, redis, agentId);
    await bumpOrgEpoch(redis, orgId, v1.policyEpoch);

    // Edit the spend policy (cap $10 -> $5): Postgres epoch bumps and the org counter is signalled,
    // but the agent's blob is NOT yet rewritten — it sits at the propagation tail, stale.
    const edit = await createPolicyVersion(pool, {
      policyId: spendPolicyId,
      orgId,
      class: 'spend',
      rules: spendAt(5),
    });
    await bumpOrgEpoch(redis, orgId, edit.policyEpoch);

    const staleBlob = await readEffectivePolicy(redis, agentId);
    expect(staleBlob?.policyEpoch).toBe(v1.policyEpoch); // still the old epoch in cache
    expect(staleBlob?.spend.spendCap).toBe(usdc(10)); // still the old cap

    const t0 = performance.now();
    const res = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[M4] inline recompile on epoch-miss: ${elapsed.toFixed(1)}ms`);

    // The guard caught the stale epoch, recompiled inline, and now decides on the NEW version.
    expect(res.recompiled).toBe(true);
    expect(res.policy.spend.spendCap).toBe(usdc(5));
    expect(res.policy.policyEpoch).toBe(edit.policyEpoch);
    expect(elapsed).toBeLessThan(RECOMPILE_BUDGET_MS);

    // Self-heal: the cache is now fresh, so the next resolve is a cache hit.
    const fresh = await readEffectivePolicy(redis, agentId);
    expect(fresh?.policyEpoch).toBe(edit.policyEpoch);
    expect(fresh?.spend.spendCap).toBe(usdc(5));
    const second = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
    expect(second.recompiled).toBe(false);
    expect(second.policy.spend.spendCap).toBe(usdc(5));
  });

  it('recompiles when the org epoch counter is unset (cold start, current unknown)', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const { orgId, agentId } = await seedOrgAgent(pool, 8);

    // Publish a blob but deliberately leave the counter unset (no edit has propagated yet).
    await recompileAgentPolicy(pool, redis, agentId);

    const res = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
    // current === null → fail toward freshness: recompile against Postgres rather than trust cache.
    expect(res.recompiled).toBe(true);
    expect(res.policy.spend.spendCap).toBe(usdc(8));
  });
});
