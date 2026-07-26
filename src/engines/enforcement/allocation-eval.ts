import type { Redis } from 'ioredis';
import type { AllocationPolicy, DenyReason } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';
import { ALLOCATION_RESERVE_LUA } from '../../redis/lua/load.js';

/**
 * P3-B AllocationPolicy evaluator (engine-specs-FINAL.md:128, policy-engine-FINAL.md:253-262).
 *
 * Judges a treasury→agent `depositFor` request. NOT on the agent-egress hot path — it is triggered by
 * Provisioning's float-threshold event (M6); it ships here so both policy classes live under one
 * enforcement authority. Three money-critical rules:
 *   - `org:{id}:deny_all` is the FIRST gate (BUG-36): a suspended org reserves nothing.
 *   - the budget reserve is ATOMIC (BUG-19): `available = total − committed − reserved` is checked and
 *     `reserved` incremented in one Lua script, so concurrent requests cannot oversubscribe the budget.
 *   - the SOLVENCY ceiling runs in that SAME atomic step: outstanding allocations plus this request may
 *     never exceed the org's real deposited balance (`fundedTotal`). The policy budget is an intent
 *     dial; funded balance is custody truth. Before this gate existed, an org that had deposited
 *     NOTHING into the parent treasury could still provision agent float up to its policy budget —
 *     handing agents spending authority against money that was never there. Both bounds apply; the
 *     tighter one wins.
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
  /**
   * The org's REAL deposited balance for this network (sum of credited treasury_deposit_intents), in
   * base units. The SOLVENCY ceiling, enforced atomically alongside the policy budget: an org may never
   * allocate agent float exceeding what it actually deposited into the parent treasury. A zero here
   * means no float can be provisioned at all, which is the correct behaviour for an unfunded org.
   *
   * REQUIRED, and deliberately not optional-with-a-default: an omitted-means-unlimited parameter is how
   * this gate would silently regress if a future call site forgets it. Callers read it from
   * `getTreasuryBalances(...).available`.
   */
  fundedTotal: bigint;
}

interface AllocationCommands {
  reserveAllocation(
    committedKey: string,
    reservedKey: string,
    total: string,
    requested: string,
    fundedTotal: string,
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

  // 3. Atomic budget + solvency reserve LAST (BUG-19): both ceilings and the INCR in one Lua. Success
  //    here is the final gate. The script enforces the policy budget AND the org's real deposited
  //    balance; the tighter bound wins and the two rejections are reported distinctly.
  registerAllocationScript(redis);
  const reserved = await (redis as AllocationRedis).reserveAllocation(
    keys.allocationCommitted(params.orgId),
    keys.allocationReserved(params.orgId),
    params.policy.totalBudget.toString(),
    params.requested.toString(),
    params.fundedTotal.toString(),
  );
  // -1 = the money does not exist; 0 = the policy dial refused it. Keeping these apart matters: an
  // operator who sees `allocation_exceeded` raises the budget and retries, which would never fix an
  // unfunded treasury.
  if (reserved === -1) return { allow: false, reason: 'treasury_insufficient_funds' };
  if (reserved !== 1) return { allow: false, reason: 'allocation_exceeded' };

  return { allow: true };
}
