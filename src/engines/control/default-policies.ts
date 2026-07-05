import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { SpendPolicy, AllocationPolicy } from '../../contracts/index.js';
import { createPolicyVersion, assignPolicy } from './store.js';
import { bumpOrgEpoch } from './epoch.js';

const CSPR = 1_000_000_000n; // 1 CSPR in motes (9 decimals)

/**
 * Seed a brand-new org with a WORKING default policy baseline: one org-scoped spend layer + one
 * allocation layer. The effective-policy compiler requires at least one layer per class — without this,
 * a self-serve org's agents fail closed with HTTP 500 (`compileSpend/compileAllocation: at least one
 * layer required`) on every policy read, float provision, and authorize. The demo seeds these for its
 * own org; this is the equivalent for the self-serve `POST /v1/orgs` path, so the product works end to
 * end the moment an org is created.
 *
 * CasperHacks posture: the org layer includes only the demo Casper services/rails plus the source raw
 * x402 rail, and children can still narrow that list. `allowedDestinations` is the operator's Casper
 * account hash — the OWN-AGENTS allowlist that `depositFor` checks. On Casper this is an account hash
 * string (64 hex chars), not an EVM address. The owner refines all of these from the console; these
 * defaults guarantee the compiler has a valid parent layer for both source routes and AgentOps.
 */
export async function seedDefaultOrgPolicies(
  pool: pg.Pool,
  redis: Redis,
  params: { orgId: string; operatorAccountHash: string },
): Promise<void> {
  const spend: SpendPolicy = {
    spendCap: 100n * CSPR,
    perTransactionMax: 25n * CSPR,
    serviceScope: ['svc:casper-paid-api', 'svc:order-book', 'svc:risk-oracle', 'svc:trade-log-publish', 'cspr.trade:swap', 'casper:deploy:guard-registry'],
    railPermission: ['raw-x402', 'casper-x402', 'cspr-trade', 'casper-deploy'],
    velocityLimitPerHour: 60,
  };
  const allocation: AllocationPolicy = {
    totalBudget: 1000n * CSPR,
    perAgentMax: 100n * CSPR,
    cooldownSeconds: 0,
    allowedDestinations: [params.operatorAccountHash],
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
  await bumpOrgEpoch(redis, params.orgId, ap.policyEpoch);
}
