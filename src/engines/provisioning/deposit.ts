import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { AllocationPolicy, DenyReason } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';
import { evaluateAllocation } from '../enforcement/allocation-eval.js';
import type { CasperTreasuryClient } from '../../lib/casper/treasury-client.js';

/**
 * E5 Provisioning — `depositFor` / `topup` (engine-specs-FINAL.md:128, policy-engine-FINAL.md:253-262).
 *
 * Funds a per-agent float from the org treasury. Every deposit is gated by the P3-B AllocationPolicy
 * evaluator (the own-agent destination fence + per-agent max + the atomic budget reserve), then submitted
 * through THE single Casper treasury client, then reflected as `float_pending` ONLY — pending float is
 * NEVER spendable (BUG-29). Promotion to `float_confirmed` and the cold-ledger `recordAllocation` happen
 * at L3 on on-chain finality, so a deposit that never confirms can never be spent.
 *
 * Custody note (reconciliation, no spec fork): the treasury is a native CSPR transfer submitted via the
 * Casper treasury client — there is NO client-side EIP-712 signature on this path (that was never
 * applicable to Casper). The treasury-allocation / internal-allocation KMS fence (`signer.ts`) governs
 * the self-custody rail, where agentOps itself signs. The external-redirect threat is closed here by the
 * own-agent destination fence in `evaluateAllocation` plus forwarding `agentFloatAddress` as the transfer
 * destination.
 */

export interface ProvisionDeps {
  pool: pg.Pool; // used by L3 confirm (recordAllocation); part of the provisioning deps bundle
  redis: Redis;
  gateway: CasperTreasuryClient;
}

export interface DepositForParams {
  orgId: string;
  agentId: string;
  /** The recipient agent's float address — the own-agent fence destination (AllocationPolicy.allowedDestinations). */
  agentFloatAddress: string;
  amount: bigint;
  policy: AllocationPolicy;
  kind: 'depositFor' | 'topup';
  /** Seconds since this agent's last allocation; threaded for the M6 cooldown/sibling-quota check. */
  secondsSinceLastAllocation: number | null;
  /** Submit time (Unix seconds); stored so L3 finality confirm can record it as the enforcement timestamp. */
  now: number;
}

export type DepositResult =
  | { outcome: 'SUBMITTED'; allocationId: string }
  | { outcome: 'DENY'; reason: DenyReason };

export async function depositFor(
  deps: ProvisionDeps,
  params: DepositForParams,
): Promise<DepositResult> {
  const { redis, gateway } = deps;
  const { orgId, agentId, agentFloatAddress, amount, policy, kind, secondsSinceLastAllocation, now } =
    params;

  // 1. P3-B gate. A DENY reserves nothing and moves no money (it never reaches Circle).
  const decision = await evaluateAllocation(redis, {
    orgId,
    agentId,
    requested: amount,
    destination: agentFloatAddress,
    secondsSinceLastAllocation,
    policy,
  });
  if (!decision.allow) return { outcome: 'DENY', reason: decision.reason };

  // 2. The atomic reserve is now taken. Submit the internal allocation through the single Circle
  //    wrapper. On a submit failure, compensate the reserve so a transient network error never strands
  //    org budget (BUG-19 adjacent). Pending float / the in-flight record are written only post-submit.
  let txRef: string;
  try {
    const op = await gateway.depositFor({ orgId, agentId, amount, agentFloatAddress });
    txRef = op.id;
  } catch (err) {
    await redis.decrby(keys.allocationReserved(orgId), amount.toString());
    throw err;
  }

  // 3. Two-phase float: INCR float_pending ONLY (BUG-29). Confirmed float / recordAllocation wait for L3.
  await redis.incrby(keys.floatPending(agentId), amount.toString());

  // 4. Persist the in-flight PENDING record so L3 can promote pending→confirmed and record on finality,
  //    and index it under the agent so L5 teardown can sweep every in-flight deposit (BUG-21).
  const allocationId = `alloc_${randomUUID()}`;
  await redis.hset(keys.allocation(allocationId), {
    agentId,
    orgId,
    amount: amount.toString(),
    kind,
    txRef,
    state: 'PENDING',
    submittedAt: String(now),
  });
  await redis.sadd(keys.pendingAllocations(agentId), allocationId);

  return { outcome: 'SUBMITTED', allocationId };
}
