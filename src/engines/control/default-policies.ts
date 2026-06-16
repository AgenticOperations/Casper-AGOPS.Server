import type pg from 'pg';
import type { Redis } from 'ioredis';
import { privateKeyToAccount } from 'viem/accounts';
import type { SpendPolicy, AllocationPolicy } from '../../contracts/index.js';
import { createPolicyVersion, assignPolicy } from './store.js';
import { bumpOrgEpoch } from './epoch.js';

const USDC = 1_000_000n;

/**
 * Seed a brand-new org with a WORKING default policy baseline: one org-scoped spend layer + one
 * allocation layer. The effective-policy compiler requires at least one layer per class — without this,
 * a self-serve org's agents fail closed with HTTP 500 (`compileSpend/compileAllocation: at least one
 * layer required`) on every policy read, float provision, and authorize. The demo seeds these for its
 * own org; this is the equivalent for the self-serve `POST /v1/orgs` path, so the product works end to
 * end the moment an org is created.
 *
   * CasperHacks posture: the org layer includes only the demo Casper services/rails plus the source raw
   * x402 rail, and children can still narrow that list. `allowedDestinations` is the org's agent-float
   * address — the OWN-AGENTS allowlist that `depositFor` checks; in Phase-1 that is the shared env float
   * wallet. The owner refines all of these from the console; these defaults guarantee the compiler has a
   * valid parent layer for both the source routes and Casper Guard.
 */
export async function seedDefaultOrgPolicies(
  pool: pg.Pool,
  redis: Redis,
  params: { orgId: string; agentFloatAddress: string },
): Promise<void> {
  const spend: SpendPolicy = {
    spendCap: 100n * USDC,
    perTransactionMax: 25n * USDC,
    serviceScope: ['svc:casper-paid-api', 'cspr.trade:swap', 'casper:deploy:guard-registry'],
    railPermission: ['raw-x402', 'casper-x402', 'cspr-trade', 'casper-deploy'],
    velocityLimitPerHour: 60,
  };
  const allocation: AllocationPolicy = {
    totalBudget: 1000n * USDC,
    perAgentMax: 100n * USDC,
    cooldownSeconds: 0,
    allowedDestinations: [params.agentFloatAddress],
  };

  const sp = await createPolicyVersion(pool, { orgId: params.orgId, class: 'spend', rules: spend });
  const ap = await createPolicyVersion(pool, {
    orgId: params.orgId,
    class: 'allocation',
    rules: allocation,
  });
  await assignPolicy(pool, {
    orgId: params.orgId,
    scope: 'org',
    scopeId: params.orgId,
    policyId: sp.policyId,
    class: 'spend',
  });
  await assignPolicy(pool, {
    orgId: params.orgId,
    scope: 'org',
    scopeId: params.orgId,
    policyId: ap.policyId,
    class: 'allocation',
  });
  // Mirror the org's now-advanced policy epoch to the Redis hot tier so the staleness guard is correct.
  await bumpOrgEpoch(redis, params.orgId, ap.policyEpoch);
}

/** The org's agent-float address (OWN-AGENTS depositFor allowlist) derived from the configured key. */
export function deriveAgentFloatAddress(agentFloatPrivateKey: string): string {
  return privateKeyToAccount(agentFloatPrivateKey as `0x${string}`).address;
}
