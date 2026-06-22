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
import {
  publishEffectivePolicy,
  readEffectivePolicy,
  recompileAgentPolicy,
} from '../../src/engines/control/publish.js';
import { bumpOrgEpoch } from '../../src/engines/control/epoch.js';
import { resolveEffectivePolicy } from '../../src/engines/enforcement/policy-epoch-guard.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { AllocationPolicy, EffectivePolicy, SpendPolicy } from '../../src/contracts/index.js';

/**
 * SPIKE-05 (doc 04 §4, gate NFR-03): two empirical questions the epoch guard's correctness depends
 * on, neither resolvable on paper (PHASE-1-SPIKES.md:49-55):
 *   (a) how long does a sequential per-agent `effective_policy` rewrite take for N = 100 / 1k / 5k?
 *       — this is the worst-case stale-policy window the guard must cover.
 *   (b) does a single-agent inline recompile on a cache-epoch-miss fit the P3-A hot-path budget
 *       (<500ms total)? — the guard is only safe if its fallback fits.
 *
 * Durability/correctness is proven elsewhere (policy-epoch-guard.test.ts); here we MEASURE and
 * record the numbers into spike-results.md. CI ceilings are loose (Docker-bridge overhead), not the
 * calibrated production budget — except (b)'s 500ms, which is the real NFR-03 gate.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const TAIL_SIZES = [100, 1000, 5000];
const RECOMPILE_SAMPLES = 50;
const RECOMPILE_BUDGET_MS = 500; // the real NFR-03 hot-path budget
const TAIL_CEILING_MS = 30_000; // generous CI sanity ceiling for 5k sequential SETs over Docker

let pgc: StartedPostgreSqlContainer | undefined;
let redisc: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function representativeBlob(i: number): EffectivePolicy {
  const spend: SpendPolicy = {
    spendCap: usdc(10),
    perTransactionMax: usdc(10),
    serviceScope: ['svc:a', 'svc:b'],
    railPermission: ['raw-x402', 'circle-nano'],
    velocityLimitPerHour: 10,
  };
  const allocation: AllocationPolicy = {
    totalBudget: usdc(200),
    perAgentMax: usdc(10),
    cooldownSeconds: 0,
    allowedDestinations: ['0xVendor'],
  };
  return {
    agentId: `agt_tail_${i}`,
    orgId: 'org_tail',
    policyId: 'policy_tail@v1',
    policyEpoch: 1,
    spend,
    allocation,
  };
}

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

describe('SPIKE-05 — policy-epoch propagation tail + inline-recompile latency', () => {
  it('measures the sequential rewrite tail (N=100/1k/5k) and a single inline recompile', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool || !redis) return skip();

    // ── (a) propagation tail: time a sequential per-agent blob rewrite for each N ──────────────
    for (const n of TAIL_SIZES) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        await publishEffectivePolicy(redis, representativeBlob(i));
      }
      const elapsed = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[SPIKE-05] propagation tail N=${n}: ${elapsed.toFixed(1)}ms total, ${(elapsed / n).toFixed(3)}ms/key`,
      );
      expect(elapsed).toBeLessThan(TAIL_CEILING_MS);
      // Prove the writes actually landed — a silent no-op publish must not pass the timing loop.
      const lastWritten = await readEffectivePolicy(redis, `agt_tail_${n - 1}`);
      expect(lastWritten?.spend.spendCap).toBe(usdc(10));
    }

    // ── (b) inline recompile latency on a forced epoch-miss ────────────────────────────────────
    const org = await createOrg(pool, { name: 'SpikeOrg', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });
    const sp = await createPolicyVersion(pool, {
      orgId: org.id,
      class: 'spend',
      rules: representativeBlob(0).spend,
    });
    const ap = await createPolicyVersion(pool, {
      orgId: org.id,
      class: 'allocation',
      rules: representativeBlob(0).allocation,
    });
    await assignPolicy(pool, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: sp.policyId, class: 'spend' });
    await assignPolicy(pool, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: ap.policyId, class: 'allocation' });
    await recompileAgentPolicy(pool, redis, agent.id);

    // Pin the org counter to a high sentinel so every resolve sees the blob as stale and takes the
    // inline-recompile path. The self-heal bump (to the real, lower epoch) is monotonically refused,
    // so the sentinel holds and every sample exercises the worst-case fallback.
    await bumpOrgEpoch(redis, org.id, 1_000_000);

    const samples: number[] = [];
    for (let i = 0; i < RECOMPILE_SAMPLES; i++) {
      const t0 = performance.now();
      const res = await resolveEffectivePolicy(pool, redis, { agentId: agent.id, orgId: org.id });
      samples.push(performance.now() - t0);
      expect(res.recompiled).toBe(true); // sentinel guarantees the miss path every time
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);
    // eslint-disable-next-line no-console
    console.log(
      `[SPIKE-05] inline recompile (PG read + compile + republish): p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${RECOMPILE_SAMPLES})`,
    );

    // The hard gate: the inline fallback fits the hot-path budget.
    expect(p99).toBeLessThan(RECOMPILE_BUDGET_MS);
  }, 180_000);
});
