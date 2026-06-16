import type { AllocationPolicy, EffectivePolicy, SpendPolicy, SpendRailPermission } from '../../contracts/index.js';

/**
 * JSON (de)serialization for policies.
 *
 * USDC amounts are `bigint` in code (money is never a float — see contracts/index.ts),
 * but JSON has no bigint type. We store amounts as base-unit decimal strings and rehydrate
 * to bigint on read. This codec is the single conversion point shared by the Postgres
 * `rules` jsonb column and the Redis effective-policy blob, so both stores round-trip
 * identically.
 */

export interface SpendPolicyJson {
  spendCap: string;
  perTransactionMax: string;
  serviceScope: string[];
  railPermission: SpendRailPermission[];
  velocityLimitPerHour: number;
}

export interface AllocationPolicyJson {
  totalBudget: string;
  perAgentMax: string;
  cooldownSeconds: number;
  allowedDestinations: string[];
}

export interface EffectivePolicyJson {
  agentId: string;
  orgId: string;
  policyId: string;
  policyEpoch: number;
  spend: SpendPolicyJson;
  allocation: AllocationPolicyJson;
}

export function encodeSpend(p: SpendPolicy): SpendPolicyJson {
  return {
    spendCap: p.spendCap.toString(),
    perTransactionMax: p.perTransactionMax.toString(),
    serviceScope: p.serviceScope,
    railPermission: p.railPermission,
    velocityLimitPerHour: p.velocityLimitPerHour,
  };
}

export function decodeSpend(j: SpendPolicyJson): SpendPolicy {
  return {
    spendCap: BigInt(j.spendCap),
    perTransactionMax: BigInt(j.perTransactionMax),
    serviceScope: j.serviceScope,
    railPermission: j.railPermission,
    velocityLimitPerHour: j.velocityLimitPerHour,
  };
}

export function encodeAllocation(p: AllocationPolicy): AllocationPolicyJson {
  return {
    totalBudget: p.totalBudget.toString(),
    perAgentMax: p.perAgentMax.toString(),
    cooldownSeconds: p.cooldownSeconds,
    allowedDestinations: p.allowedDestinations,
  };
}

export function decodeAllocation(j: AllocationPolicyJson): AllocationPolicy {
  return {
    totalBudget: BigInt(j.totalBudget),
    perAgentMax: BigInt(j.perAgentMax),
    cooldownSeconds: j.cooldownSeconds,
    allowedDestinations: j.allowedDestinations,
  };
}

export function encodeEffective(e: EffectivePolicy): EffectivePolicyJson {
  return {
    agentId: e.agentId,
    orgId: e.orgId,
    policyId: e.policyId,
    policyEpoch: e.policyEpoch,
    spend: encodeSpend(e.spend),
    allocation: encodeAllocation(e.allocation),
  };
}

export function decodeEffective(j: EffectivePolicyJson): EffectivePolicy {
  return {
    agentId: j.agentId,
    orgId: j.orgId,
    policyId: j.policyId,
    policyEpoch: j.policyEpoch,
    spend: decodeSpend(j.spend),
    allocation: decodeAllocation(j.allocation),
  };
}
