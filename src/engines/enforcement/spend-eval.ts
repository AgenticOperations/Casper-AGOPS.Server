import type { DenyReason, Rail, SpendPolicy, UsdcBaseUnits } from '../../contracts/index.js';
import type { SpendWindow } from '../../redis/keyspace.js';

/**
 * P3-A SpendPolicy evaluator (policy-engine-FINAL.md:103-109, engine-specs-FINAL.md:127).
 *
 * Pure decision: it judges a captured policy snapshot against the quote + hold-inclusive window
 * utilization and returns ALLOW or the first failing reason_code. No I/O, no clock — the orchestrator
 * (`enforce.ts`) supplies the window sums (E4 `windowSum`) and velocity count. Deny-by-default: every
 * gate must pass, and an empty ServiceScope allowlist permits nothing.
 *
 * Order is load-bearing — the cheapest / most-categorical gates first so a forbidden rail or
 * out-of-scope destination is rejected before any cap arithmetic:
 *   RailPermission → ServiceScope → VelocityLimit → SpendCap (every window) → per_transaction_max.
 */

export type SpendDecision = { allow: true } | { allow: false; reason: DenyReason };

export interface SpendEvalInput {
  policy: SpendPolicy;
  amount: UsdcBaseUnits;
  railScheme: Rail['scheme'];
  resourceId: string;
  /** Hold-inclusive committed base units per window (E4 `windowSum` already counts holds). */
  windowUtil: Record<SpendWindow, bigint>;
  /** Count of transactions already in the velocity window. */
  velocityCount: number;
}

export function evaluateSpend(input: SpendEvalInput): SpendDecision {
  const { policy, amount, railScheme, resourceId, windowUtil, velocityCount } = input;

  // 1. RailPermission — only an enumerated, permitted rail is signable.
  if (!policy.railPermission.includes(railScheme)) {
    return { allow: false, reason: 'rail_not_permitted' };
  }

  // 2. ServiceScope — ALLOWLIST; an empty scope allows nothing (deny-by-default).
  if (!policy.serviceScope.includes(resourceId)) {
    return { allow: false, reason: 'service_not_allowed' };
  }

  // 3. VelocityLimit — the in-window tx count must stay strictly under the cap.
  if (velocityCount >= policy.velocityLimitPerHour) {
    return { allow: false, reason: 'velocity_exceeded' };
  }

  // 4. SpendCap — hold-inclusive consumed + amount ≤ cap, in EVERY window.
  for (const window of Object.keys(windowUtil) as SpendWindow[]) {
    const consumed = windowUtil[window] ?? 0n;
    if (consumed + amount > policy.spendCap) {
      return { allow: false, reason: 'spend_cap_exceeded' };
    }
  }

  // 5. per_transaction_max — single-transaction ceiling.
  if (amount > policy.perTransactionMax) {
    return { allow: false, reason: 'per_transaction_max_exceeded' };
  }

  return { allow: true };
}
