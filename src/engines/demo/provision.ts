import type pg from 'pg';
import type { Redis } from 'ioredis';
import { hashApiKey } from '../../lib/ids.js';
import { createOrg, registerAgent, createPolicyVersion, assignPolicy } from '../control/store.js';
import { recompileAgentPolicy } from '../control/publish.js';
import { bumpOrgEpoch } from '../control/epoch.js';
import { keys } from '../../redis/keyspace.js';
import type { AllocationPolicy, SpendPolicy } from '../../contracts/index.js';

const CSPR = 1_000_000_000n; // 1 CSPR in motes (9 decimals)

export interface DemoHandle {
  org_id: string;
  agent_id: string;
  agent_key: string;
  agent_b_id: string;
  agent_b_key: string;
  spend_cap: string; // base-unit string (motes)
  authorize_template: {
    accept: {
      scheme: string;
      network: string;
      resource: string;
      payTo: string;
      maxTimeoutSeconds: number;
      asset: string;
      extra: { name: string; version: string };
    };
    request_context: { method: string; url: string };
  };
}

export interface SetupDemoParams {
  adminKey: string;
  capCspr: number;
  /** Casper account hash payTo (00 + 64 hex). */
  payTo?: string;
  /** Vendor host for the authorize_template URL. */
  vendorHost?: string;
  /** Resource identifier (serviceScope). */
  resource?: string;
  /** CEP-18 token package hash (64 hex). */
  tokenPackageHash?: string;
  /** CEP-18 token name for x402 extra metadata. */
  tokenName?: string;
  /** CEP-18 token version for x402 extra metadata. */
  tokenVersion?: string;
}

/**
 * Provision a fresh demo agent in the operator's org. Uses Casper x402 (CSPR motes, casper:casper-test)
 * instead of Arc/EVM. Self-bootstraps the org from the presented sk_ hash if it does not yet exist.
 */
export async function setupDemoAgent(
  pool: pg.Pool,
  redis: Redis,
  params: SetupDemoParams,
): Promise<DemoHandle> {
  const payTo =
    params.payTo ?? '0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267';
  const vendorHost = params.vendorHost ?? 'api.casperguard.demo';
  const resource = params.resource ?? 'svc:casper-paid-api';
  const tokenPackageHash =
    params.tokenPackageHash ?? '0000000000000000000000000000000000000000000000000000000000000001';
  const tokenName = params.tokenName ?? 'CSPRX';
  const tokenVersion = params.tokenVersion ?? '1';

  const hash = hashApiKey(params.adminKey);

  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM orgs WHERE admin_key_hash = $1',
    [hash],
  );
  const orgId =
    existing.rows[0]?.id ??
    (await createOrg(pool, { name: 'Demo Org', adminKeyHash: hash })).id;

  const { agent, apiKey } = await registerAgent(pool, { orgId });
  const { agent: agentB, apiKey: apiKeyB } = await registerAgent(pool, { orgId });
  const cap = BigInt(params.capCspr) * CSPR;

  const spend: SpendPolicy = {
    spendCap: cap,
    perTransactionMax: 1000n * CSPR,
    serviceScope: [resource, 'cspr.trade:swap', 'casper:deploy:guard-registry'],
    railPermission: ['casper-x402', 'cspr-trade', 'casper-deploy'],
    velocityLimitPerHour: 100,
  };

  // AllocationPolicy uses a zero-address placeholder — Casper demo is policy-only, no float dance.
  const allocation: AllocationPolicy = {
    totalBudget: 1000n * CSPR,
    perAgentMax: 1000n * CSPR,
    cooldownSeconds: 0,
    allowedDestinations: [],
  };

  // Remove all previous org-scope assignments before inserting new ones. assignPolicy is a plain
  // INSERT — without this, each demo run accumulates extra org-scope rows that all get intersected
  // by the compiler, which wipes out any scope entry not present in EVERY historical row.
  await pool.query(
    "DELETE FROM policy_assignments WHERE org_id = $1 AND scope = 'org' AND scope_id = $1",
    [orgId],
  );

  const sp = await createPolicyVersion(pool, { orgId, class: 'spend', rules: spend });
  const ap = await createPolicyVersion(pool, { orgId, class: 'allocation', rules: allocation });
  await assignPolicy(pool, { orgId, scope: 'org', scopeId: orgId, policyId: sp.policyId, class: 'spend' });
  await assignPolicy(pool, { orgId, scope: 'org', scopeId: orgId, policyId: ap.policyId, class: 'allocation' });
  const eff = await recompileAgentPolicy(pool, redis, agent.id);
  await recompileAgentPolicy(pool, redis, agentB.id);
  await bumpOrgEpoch(redis, orgId, eff.policyEpoch);

  return {
    org_id: orgId,
    agent_id: agent.id,
    agent_key: apiKey.token,
    agent_b_id: agentB.id,
    agent_b_key: apiKeyB.token,
    spend_cap: cap.toString(),
    authorize_template: {
      accept: {
        scheme: 'exact',
        network: 'casper:casper-test',
        resource,
        payTo,
        maxTimeoutSeconds: 600,
        asset: tokenPackageHash,
        extra: { name: tokenName, version: tokenVersion },
      },
      request_context: { method: 'GET', url: `https://${vendorHost}/v1/current` },
    },
  };
}

/**
 * Retire all demo agents for the org + lift the kill-switch so a re-run starts clean.
 */
export async function resetDemo(
  pool: pg.Pool,
  redis: Redis,
  params: { orgId: string },
): Promise<void> {
  await pool.query("UPDATE agents SET status = 'suspended' WHERE org_id = $1", [params.orgId]);
  await redis.del(keys.denyAll(params.orgId));
}
