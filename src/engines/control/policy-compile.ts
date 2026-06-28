import type {
  AgentId,
  AllocationPolicy,
  EffectivePolicy,
  OrgId,
  PolicyId,
  SpendPolicy,
} from '../../contracts/index.js';

/**
 * Effective policy = most-restrictive intersection, root→leaf (org → team → agent).
 *
 * Governing rule: "Child can only narrow a parent, never widen" (policy-engine-FINAL.md:60).
 *
 * SpendPolicy combine table is canonical (policy-engine-FINAL.md:62-67): caps take `min`,
 * allowlists take set-intersection, velocity takes `min`. The spec is SILENT on the
 * AllocationPolicy field directions, so each is derived from the same narrow-only principle:
 * budgets `min`, `cooldownSeconds` `max` (a longer cooldown is more restrictive), destinations
 * intersect. This introduces no new architectural claim — it applies the spec's stated rule.
 */

function bigintMin(values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}
function numberMin(values: number[]): number {
  return values.reduce((a, b) => (b < a ? b : a));
}
function numberMax(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a));
}

/** Elements present in EVERY layer, preserving the first layer's order. */
function intersectAll<T>(layers: T[][]): T[] {
  if (layers.length === 0) return [];
  const first = layers[0] ?? [];
  return first.filter((item) => layers.every((layer) => layer.includes(item)));
}

export function compileSpend(layers: SpendPolicy[]): SpendPolicy {
  if (layers.length === 0) throw new Error('compileSpend: at least one layer required');
  return {
    spendCap: bigintMin(layers.map((l) => l.spendCap)),
    perTransactionMax: bigintMin(layers.map((l) => l.perTransactionMax)),
    // serviceScope unions across all layers: org sets the baseline every agent gets,
    // and agent layers can extend it with additional services. Deduped, org-first order.
    serviceScope: [...new Set(layers.flatMap((l) => l.serviceScope))],
    railPermission: intersectAll(layers.map((l) => l.railPermission)),
    velocityLimitPerHour: numberMin(layers.map((l) => l.velocityLimitPerHour)),
  };
}

export function compileAllocation(layers: AllocationPolicy[]): AllocationPolicy {
  if (layers.length === 0) throw new Error('compileAllocation: at least one layer required');
  return {
    totalBudget: bigintMin(layers.map((l) => l.totalBudget)),
    perAgentMax: bigintMin(layers.map((l) => l.perAgentMax)),
    cooldownSeconds: numberMax(layers.map((l) => l.cooldownSeconds)),
    allowedDestinations: intersectAll(layers.map((l) => l.allowedDestinations)),
  };
}

export interface CompileInput {
  agentId: AgentId;
  orgId: OrgId;
  policyId: PolicyId;
  policyEpoch: number;
  /** Root → leaf (org first, agent last). */
  spendLayers: SpendPolicy[];
  /** Root → leaf (org first, agent last). */
  allocationLayers: AllocationPolicy[];
}

export function compileEffectivePolicy(input: CompileInput): EffectivePolicy {
  return {
    agentId: input.agentId,
    orgId: input.orgId,
    policyId: input.policyId,
    policyEpoch: input.policyEpoch,
    spend: compileSpend(input.spendLayers),
    allocation: compileAllocation(input.allocationLayers),
  };
}
