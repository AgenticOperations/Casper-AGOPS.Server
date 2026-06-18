import type { Redis } from 'ioredis';
import type { AllocationPolicy, DenyReason } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';
import { ALLOCATION_RESERVE_LUA } from '../../redis/lua/load.js';

/**
 * P3-B AllocationPolicy evaluator (engine-specs-FINAL.md:128, policy-engine-FINAL.md:253-262).
 *
 * Judges a treasury→agent `depositFor` request. NOT on the agent-egress hot path — it is triggered by
 * Provisioning's float-threshold event (M6); it ships here so both policy classes live under one
 * enforcement authority. Two money-critical rules:
 *   - `org:{id}:deny_all` is the FIRST gate (BUG-36): a suspended org reserves nothing.
 *   - the budget reserve is ATOMIC (BUG-19): `available = total − committed − reserved` is checked and
 *     `reserved` incremented in one Lua script, so concurrent requests cannot oversubscribe the budget.
 *
 * The request-local checks (per_agent_max, the own-agent destination fence) run before the reserve —
 * they share no mutable state, so ordering them first only avoids reserve/release churn and does not
 * reopen the TOCTOU the atomic reserve closes (the budget check + INCR remain one atomic step, and a
 * successful reserve is the final gate → ALLOW, so there is never a post-reserve gate forcing a
 * release). The per-agent `cooldownSeconds` check is wired here (M6): the caller supplies
 * `secondsSinceLastAllocation` from the allocation history Provisioning owns. `sibling_quota`
 * (product-architecture-FINAL.md:141 — a child's fraction of a SHARED PARENT budget) is DEFERRED: the
 * Phase-1 AllocationPolicy has no parent/child allocation topology or quota field for it to act on, so
 * enforcing it would require introducing that nested model first (out of the Phase-1 MVP cut).
 */

export type AllocationDecision = { allow: true } | { allow: false; reason: DenyReason };

export interface AllocationEvalParams {
  orgId: string;
  agentId?: string;
  requested: bigint;
  /** The depositFor destination — must be one of the org's own agents (the fence). */
  destination: string;
  /** Seconds since this agent's last allocation; null = never. Reserved for the M6 cooldown check. */
  secondsSinceLastAllocation: number | null;
  policy: AllocationPolicy;
}

interface AllocationCommands {
  reserveAllocation(
    committedKey: string,
    reservedKey: string,
    total: string,
    requested: string,
  ): Promise<number>;
}
type AllocationRedis = Redis & AllocationCommands;

const REGISTERED = new WeakSet<Redis>();

/** Idempotently attach the atomic budget-reserve Lua to a client (ioredis runs it via EVALSHA). */
export function registerAllocationScript(redis: Redis): void {
  if (REGISTERED.has(redis)) return;
  redis.defineCommand('reserveAllocation', { numberOfKeys: 2, lua: ALLOCATION_RESERVE_LUA });
  REGISTERED.add(redis);
}

export async function evaluateAllocation(
  redis: Redis,
  params: AllocationEvalParams,
): Promise<AllocationDecision> {
  // 1. First gate (BUG-36): the org kill-switch freezes NEW allocations. Reserve nothing.
  const suspended = await redis.exists(keys.denyAll(params.orgId));
  if (suspended === 1) return { allow: false, reason: 'org_suspended' };

  // 2. Request-local checks (no shared state) — cheap, so before the reserve to avoid churn.
  if (params.requested > params.policy.perAgentMax) {
    return { allow: false, reason: 'allocation_exceeded' };
  }
  if (!params.policy.allowedDestinations.includes(params.destination)) {
    // Destination fence: a depositFor may only fund the org's own agents, never an external address.
    return { allow: false, reason: 'service_not_allowed' };
  }
  // Per-agent cooldown (BUG: necessary-not-sufficient — multi-agent spread evades it, total_budget is the
  // real bound). A null gap = never allocated → no cooldown. The boundary is inclusive: a gap exactly equal
  // to the cooldown has elapsed and passes.
  if (
    params.policy.cooldownSeconds > 0 &&
    params.secondsSinceLastAllocation !== null &&
    params.secondsSinceLastAllocation < params.policy.cooldownSeconds
  ) {
    return { allow: false, reason: 'allocation_cooldown' };
  }

  // 3. Atomic budget reserve LAST (BUG-19): check + INCR in one Lua. Success here is the final gate.
  registerAllocationScript(redis);
  const reserved = await (redis as AllocationRedis).reserveAllocation(
    keys.allocationCommitted(params.orgId),
    keys.allocationReserved(params.orgId),
    params.policy.totalBudget.toString(),
    params.requested.toString(),
  );
  if (reserved !== 1) return { allow: false, reason: 'allocation_exceeded' };

  return { allow: true };
}
