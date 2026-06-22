import type pg from 'pg';
import type { Redis } from 'ioredis';
import { privateKeyToAccount } from 'viem/accounts';
import { hashApiKey } from '../../lib/ids.js';
import { createOrg, registerAgent, createPolicyVersion, assignPolicy } from '../control/store.js';
import { recompileAgentPolicy } from '../control/publish.js';
import { bumpOrgEpoch } from '../control/epoch.js';
import { keys } from '../../redis/keyspace.js';
import type { AllocationPolicy, SpendPolicy } from '../../contracts/index.js';

const USDC = 1_000_000n;

export interface DemoHandle {
  org_id: string;
  agent_id: string;
  agent_key: string;
  spend_cap: string; // base-unit string
  authorize_template: {
    accept: {
      scheme: string;
      network: string;
      resource: string;
      payTo: string;
      maxTimeoutSeconds: number;
      asset: string;
    };
    request_context: { method: string; url: string };
  };
}

export interface SetupDemoParams {
  adminKey: string;
  capUsdc: number;
  /** Vendor payTo address (E7 binding target). Defaults to DEMO_VENDOR_ADDRESS env default. */
  vendorAddress?: string;
  /** Vendor host for the authorize_template URL. */
  vendorHost?: string;
  /** Resource identifier (serviceScope). */
  resource?: string;
  /** USDC token address for the authorize_template asset. */
  token?: string;
  /** The org's own agent-float address (for AllocationPolicy allowedDestinations). */
  agentFloatPrivateKey?: string;
}

/**
 * Provision a fresh demo agent in the operator's org (doc 04 §5 step 1, the seedAgent path proven by
 * test/oracle/authorize-allow-then-deny.test.ts). Self-bootstraps the org from the presented sk_ hash
 * if it does not yet exist (dev/demo only; the route is env-gated).
 *
 * Admin key hashing uses the EXACT same `hashApiKey` (SHA-256-hex) that `issueAdminKey` and
 * `authenticateAdmin` use — so a bootstrap here is immediately authenticatable via `authenticateAdmin`.
 *
 * AllocationPolicy.allowedDestinations is the org's agent-float address (OWN-AGENTS allowlist), never
 * the vendor — matching seedAgent in oracle-harness.ts exactly.
 *
 * Policy-only — no float dance — so the killer cell (ALLOW under cap, DENY over cap) is deterministic.
 * Returns the ag_live_ key for the BFF's server-only demo session; the key never reaches the browser.
 */
export async function setupDemoAgent(
  pool: pg.Pool,
  redis: Redis,
  params: SetupDemoParams,
): Promise<DemoHandle> {
  // Resolve agent-float address: used as AllocationPolicy.allowedDestinations (OWN-AGENTS fence).
  // Defaults to the well-known anvil key whose address is 0x70997970c51812dc3a010c7d01b50e0d17dc79c8.
  const agentFloatPrivKey =
    params.agentFloatPrivateKey ??
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const agentFloatAddress = privateKeyToAccount(agentFloatPrivKey as `0x${string}`).address;

  const vendorAddress =
    params.vendorAddress ?? '0x4444444444444444444444444444444444444444';
  const vendorHost = params.vendorHost ?? 'api.weather.example';
  const resource = params.resource ?? 'svc:weather';
  const token =
    params.token ?? '0x5555555555555555555555555555555555555555';

  // hashApiKey is the canonical SHA-256-hex used by issueAdminKey + authenticateAdmin.
  const hash = hashApiKey(params.adminKey);

  // Resolve-or-bootstrap the org from the presented sk_ hash.
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM orgs WHERE admin_key_hash = $1',
    [hash],
  );
  const orgId =
    existing.rows[0]?.id ??
    (await createOrg(pool, { name: 'Demo Org', adminKeyHash: hash })).id;

  const { agent, apiKey } = await registerAgent(pool, { orgId });
  const cap = BigInt(params.capUsdc) * USDC;

  const spend: SpendPolicy = {
    spendCap: cap,
    perTransactionMax: 1000n * USDC,
    serviceScope: [resource],
    railPermission: ['raw-x402'],
    velocityLimitPerHour: 100,
  };

  // AllocationPolicy.allowedDestinations = the org's OWN agent-float address (the depositFor
  // OWN-AGENTS allowlist, policy-engine-FINAL.md:128). Never a vendor address. Mirrors seedAgent.
  const allocation: AllocationPolicy = {
    totalBudget: 1000n * USDC,
    perAgentMax: 1000n * USDC,
    cooldownSeconds: 0,
    allowedDestinations: [agentFloatAddress],
  };

  const sp = await createPolicyVersion(pool, { orgId, class: 'spend', rules: spend });
  const ap = await createPolicyVersion(pool, { orgId, class: 'allocation', rules: allocation });
  await assignPolicy(pool, { orgId, scope: 'org', scopeId: orgId, policyId: sp.policyId, class: 'spend' });
  await assignPolicy(pool, { orgId, scope: 'org', scopeId: orgId, policyId: ap.policyId, class: 'allocation' });
  const eff = await recompileAgentPolicy(pool, redis, agent.id);
  await bumpOrgEpoch(redis, orgId, eff.policyEpoch);

  return {
    org_id: orgId,
    agent_id: agent.id,
    agent_key: apiKey.token,
    spend_cap: cap.toString(),
    authorize_template: {
      accept: {
        scheme: 'exact',
        network: 'arc-testnet',
        resource,
        payTo: vendorAddress,
        maxTimeoutSeconds: 600,
        asset: token,
      },
      request_context: { method: 'GET', url: `https://${vendorHost}/v1/current` },
    },
  };
}

/**
 * Retire all demo agents for the org + lift the kill-switch so a re-run starts clean.
 * Agents are suspended (append-only ledger → fresh agent on next setup).
 * The org:deny_all key is removed to unblock future authorizations.
 */
export async function resetDemo(
  pool: pg.Pool,
  redis: Redis,
  params: { orgId: string },
): Promise<void> {
  await pool.query("UPDATE agents SET status = 'suspended' WHERE org_id = $1", [params.orgId]);
  await redis.del(keys.denyAll(params.orgId));
}
