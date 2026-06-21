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
  createTeam,
  getLatestPolicyVersion,
  getPolicyVersion,
  registerAgent,
} from '../../src/engines/control/store.js';
import { readEffectivePolicy, recompileAgentPolicy } from '../../src/engines/control/publish.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { AllocationPolicy, SpendPolicy } from '../../src/contracts/index.js';

/**
 * Thesis claims:
 *  - Policy is immutable `policy_id@vN`; an edit creates a new version (policy-engine-FINAL.md:47-48).
 *  - M2 acceptance: assign Spend + Allocation, compile the effective policy into Redis with an epoch.
 * Requires Docker; skips itself when no container runtime is available.
 */

let pgc: StartedPostgreSqlContainer | undefined;
let redisc: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

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

describe('policy versioning is immutable; epoch is monotonic', () => {
  it('an edit creates a new version, never mutating the prior one', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'Acme', adminKeyHash: issueAdminKey().hash });

    const spendV1: SpendPolicy = {
      spendCap: usdc(10),
      perTransactionMax: usdc(10),
      serviceScope: ['svc:a'],
      railPermission: ['raw-x402'],
      velocityLimitPerHour: 10,
    };
    const v1 = await createPolicyVersion(pool, { orgId: org.id, class: 'spend', rules: spendV1 });
    expect(v1.version).toBe(1);

    const spendV2: SpendPolicy = { ...spendV1, spendCap: usdc(5) };
    const v2 = await createPolicyVersion(pool, {
      policyId: v1.policyId,
      orgId: org.id,
      class: 'spend',
      rules: spendV2,
    });
    expect(v2.version).toBe(2);
    expect(v2.policyId).toBe(v1.policyId);

    const readV1 = await getPolicyVersion(pool, v1.policyId, 1);
    expect(readV1?.class).toBe('spend');
    if (readV1?.class === 'spend') expect(readV1.rules.spendCap).toBe(usdc(10)); // v1 unchanged

    const latest = await getLatestPolicyVersion(pool, v1.policyId);
    expect(latest?.version).toBe(2);
    if (latest?.class === 'spend') expect(latest.rules.spendCap).toBe(usdc(5));

    expect(v2.policyEpoch).toBe(2); // bumped once per version write (0 → 1 → 2)
  });

  it('compiles assigned policies into a Redis blob carrying the org epoch', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const org = await createOrg(pool, { name: 'Globex', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    const spend: SpendPolicy = {
      spendCap: usdc(10),
      perTransactionMax: usdc(10),
      serviceScope: ['svc:a'],
      railPermission: ['raw-x402'],
      velocityLimitPerHour: 10,
    };
    const alloc: AllocationPolicy = {
      totalBudget: usdc(200),
      perAgentMax: usdc(10),
      cooldownSeconds: 0,
      allowedDestinations: ['0xVendor'],
    };
    const sp = await createPolicyVersion(pool, { orgId: org.id, class: 'spend', rules: spend });
    const ap = await createPolicyVersion(pool, {
      orgId: org.id,
      class: 'allocation',
      rules: alloc,
    });
    await assignPolicy(pool, {
      orgId: org.id,
      scope: 'org',
      scopeId: org.id,
      policyId: sp.policyId,
      class: 'spend',
    });
    await assignPolicy(pool, {
      orgId: org.id,
      scope: 'org',
      scopeId: org.id,
      policyId: ap.policyId,
      class: 'allocation',
    });

    const eff = await recompileAgentPolicy(pool, redis, agent.id);
    expect(eff.spend.spendCap).toBe(usdc(10));
    expect(eff.allocation.totalBudget).toBe(usdc(200));
    expect(eff.policyEpoch).toBe(2); // two version writes under this org

    const blob = await readEffectivePolicy(redis, agent.id);
    expect(blob?.spend.spendCap).toBe(usdc(10));
    expect(blob?.policyEpoch).toBe(2);
  });

  it('applies an ANCESTOR team policy to an agent under a nested child team', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const org = await createOrg(pool, { name: 'Initech', adminKeyHash: issueAdminKey().hash });
    const parent = await createTeam(pool, { orgId: org.id, name: 'Parent' });
    const child = await createTeam(pool, { orgId: org.id, name: 'Child', parentTeamId: parent.id });
    const { agent } = await registerAgent(pool, { orgId: org.id, teamId: child.id });

    const loose: SpendPolicy = {
      spendCap: usdc(100),
      perTransactionMax: usdc(100),
      serviceScope: ['svc:a', 'svc:b'],
      railPermission: ['raw-x402', 'circle-nano'],
      velocityLimitPerHour: 100,
    };
    const tight: SpendPolicy = {
      spendCap: usdc(7),
      perTransactionMax: usdc(7),
      serviceScope: ['svc:a'],
      railPermission: ['raw-x402'],
      velocityLimitPerHour: 5,
    };
    const alloc: AllocationPolicy = {
      totalBudget: usdc(200),
      perAgentMax: usdc(10),
      cooldownSeconds: 0,
      allowedDestinations: ['0xV'],
    };

    const orgSpend = await createPolicyVersion(pool, { orgId: org.id, class: 'spend', rules: loose });
    const parentSpend = await createPolicyVersion(pool, {
      orgId: org.id,
      class: 'spend',
      rules: tight,
    });
    const orgAlloc = await createPolicyVersion(pool, {
      orgId: org.id,
      class: 'allocation',
      rules: alloc,
    });
    await assignPolicy(pool, {
      orgId: org.id,
      scope: 'org',
      scopeId: org.id,
      policyId: orgSpend.policyId,
      class: 'spend',
    });
    // Assigned to the PARENT team; the agent sits under the CHILD team.
    await assignPolicy(pool, {
      orgId: org.id,
      scope: 'team',
      scopeId: parent.id,
      policyId: parentSpend.policyId,
      class: 'spend',
    });
    await assignPolicy(pool, {
      orgId: org.id,
      scope: 'org',
      scopeId: org.id,
      policyId: orgAlloc.policyId,
      class: 'allocation',
    });

    const eff = await recompileAgentPolicy(pool, redis, agent.id);
    // The ancestor-team policy MUST win the intersection (it is narrower than the org policy).
    expect(eff.spend.spendCap).toBe(usdc(7));
    expect(eff.spend.serviceScope).toEqual(['svc:a']);
    expect(eff.spend.velocityLimitPerHour).toBe(5);
  });
});
