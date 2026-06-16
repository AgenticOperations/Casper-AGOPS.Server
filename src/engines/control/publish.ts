import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { EffectivePolicy } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';
import { decodeEffective, encodeEffective, type EffectivePolicyJson } from './codec.js';
import { compileEffectivePolicy } from './policy-compile.js';
import { getEffectiveLayers } from './store.js';

/**
 * Publish a compiled effective policy to the Redis hot tier (C-1 blob consumed by
 * Enforcement). The write is a single per-agent `SET` — an atomic overwrite, never a
 * bulk delete — so an invalidation touches exactly one key and the epoch in the blob is
 * the staleness guard.
 */
export async function publishEffectivePolicy(redis: Redis, eff: EffectivePolicy): Promise<void> {
  await redis.set(keys.effectivePolicy(eff.agentId), JSON.stringify(encodeEffective(eff)));
}

export async function readEffectivePolicy(
  redis: Redis,
  agentId: string,
): Promise<EffectivePolicy | null> {
  const raw = await redis.get(keys.effectivePolicy(agentId));
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as EffectivePolicyJson;
  return decodeEffective(parsed);
}

/**
 * Resolve an agent's assigned policies, compile the most-restrictive intersection, and
 * publish the blob. Returns the compiled policy. Carries the org's current epoch so a
 * later authorize can detect a stale cache (NFR-03).
 */
export async function recompileAgentPolicy(
  pool: pg.Pool,
  redis: Redis,
  agentId: string,
): Promise<EffectivePolicy> {
  const layers = await getEffectiveLayers(pool, agentId);
  const eff = compileEffectivePolicy({
    agentId,
    orgId: layers.orgId,
    policyId: layers.spendPolicyRef ?? layers.allocationPolicyRef ?? 'policy_none@v0',
    policyEpoch: layers.policyEpoch,
    spendLayers: layers.spendLayers,
    allocationLayers: layers.allocationLayers,
  });
  await publishEffectivePolicy(redis, eff);
  return eff;
}
