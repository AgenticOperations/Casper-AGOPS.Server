import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { keys } from '../../redis/keyspace.js';
import { recordAllocation } from '../ledger/events.js';
import { CANCEL_ALLOCATION_LUA } from '../../redis/lua/load.js';
import { confirmDeposit } from './confirm.js';
import { suspendAgent } from '../control/kill-switch.js';
import type { ProvisionDeps } from './deposit.js';

/**
 * E5 teardown sweep (doc-04 M6, BUG-21). Decommissions an agent's float so NOTHING is stranded:
 *
 *  1. Sweep every in-flight (PENDING) allocation in the per-agent index. If its Circle op is already
 *     final, promote it (it then joins the confirmed reclaim below); otherwise CANCEL it — release the
 *     pending float AND its budget reserve, drop the in-flight record, de-index it. After the sweep,
 *     `float_pending` is guaranteed 0: no deposit can outlive the agent.
 *  2. Reclaim the remaining confirmed float to the treasury (agent-float → treasury) through THE single
 *     Circle wrapper, and write ONE balanced `teardown` allocation pair (flipped direction) so the cold
 *     ledger shows the funds returning home and the org budget commit is released.
 *
 * SPIKE-03 OPEN — do NOT freeze: the cancel path is OPTIMISTIC. A cancelled op that later settles
 * on-chain would credit float agentOps no longer tracks (untracked-credit risk). SPIKE-03 must decide
 * between mempool-cancelling the submitted op (this path) and awaiting finality before releasing. The
 * cancel mechanism here is the testable engine seam; the safety decision is deferred to the spike.
 *
 * RECLAIM-FENCE (M8): step 0 suspends the agent before the sweep + reclaim. This closes the NEW-spend
 * arm of the M6-deferred race — a fresh authorize is DENIED (agent_suspended, auth.ts:56) and never
 * reaches signing. It does NOT drain a spend already past the auth gate and mid-flight in enforceSpend:
 * draining the in-flight set against the reclaim needs BROADCASTING→finality tracking and stays SPIKE-03 /
 * M9 (alongside the mempool-cancel-vs-await-finality choice for the cancel path).
 */

export interface TeardownResult {
  /** Count of in-flight deposits resolved (promoted or cancelled) by this sweep. */
  sweptPending: number;
  /** Confirmed float reclaimed to the treasury, base units. */
  withdrawn: bigint;
}

interface CancelCommands {
  cancelAllocation(
    allocationKey: string,
    floatPendingKey: string,
    allocationReservedKey: string,
    pendingAllocationsKey: string,
    amount: string,
    allocationId: string,
  ): Promise<number>;
}
type CancelRedis = Redis & CancelCommands;

const REGISTERED = new WeakSet<Redis>();

/** Idempotently attach the single-winner cancel Lua to a client (ioredis runs it via EVALSHA). */
function registerCancelScript(redis: Redis): void {
  if (REGISTERED.has(redis)) return;
  redis.defineCommand('cancelAllocation', { numberOfKeys: 4, lua: CANCEL_ALLOCATION_LUA });
  REGISTERED.add(redis);
}

/**
 * Best-effort retire-time WCSPR sweep bundle (Task 7). Present only when funding is configured AND the
 * agent has a delegated key/public key. `run` is `sweepAgentWcsprOnChain` bound to its deps; kept as an
 * injected fn so teardown stays free of casper-js-sdk in unit tests.
 */
export interface TeardownSweep {
  run(input: {
    agentId: string;
    agentAccountHash: string;
    agentPublicKeyHex: string;
  }): Promise<{ swept: bigint; txHash?: string }>;
  agentAccountHash: string;
  agentPublicKeyHex: string;
  /** Amount to record in the residual marker if the sweep throws before reading the balance. */
  residualAmountHint?: string;
}

export async function teardownAgent(
  deps: ProvisionDeps,
  params: { orgId: string; agentId: string; now: number; sweep?: TeardownSweep },
): Promise<TeardownResult> {
  const { pool, redis, gateway } = deps;
  const { orgId, agentId, now } = params;

  // 0. FENCE (M8). Suspend the agent BEFORE sweeping and reclaiming, so a NEW authorize is DENIED
  //    (agent_suspended, auth.ts:56) and never reaches signing — closing the new-spend arm of the
  //    M6-deferred "spend racing teardown" gap. Tenant-fenced; the boolean is intentionally not used to
  //    abort: a teardown always targets a real (agentId, orgId), and aborting on a false (unknown/cross-org
  //    id) would STRAND any Redis float for that id — proceeding to reclaim is the safer choice. Draining a
  //    spend already in-flight past the auth gate against this reclaim is the deferred SPIKE-03 / M9 arm.
  await suspendAgent(pool, { agentId, orgId });

  // 1. Sweep every in-flight pending allocation so no float_pending survives teardown (BUG-21).
  //    `confirmDeposit` is the SINGLE finality authority — teardown does NOT read isFinal itself, so there
  //    is no two-read divergence that could leave a deposit stranded PENDING. Try to promote on finality;
  //    if it cannot promote (still pending), CANCEL — so every swept id ends CONFIRMED (→reclaimed below)
  //    or CANCELLED, never PENDING.
  const pendingIds = await redis.smembers(keys.pendingAllocations(agentId));
  let sweptPending = 0;
  for (const allocationId of pendingIds) {
    const rec = await redis.hgetall(keys.allocation(allocationId));
    if (rec.state !== 'PENDING') {
      // Already terminal (a concurrent confirm won) — just tidy the index; this sweep did not resolve it.
      await redis.srem(keys.pendingAllocations(agentId), allocationId);
      continue;
    }

    const confirmResult = await confirmDeposit(deps, { allocationId, now });
    if (confirmResult === 'CONFIRMED' || confirmResult === 'NOOP') {
      // Promoted by this sweep, or already confirmed by a concurrent confirmer — either way it is no longer
      // pending and its float joins the confirmed reclaim below.
      if (confirmResult === 'CONFIRMED') sweptPending += 1;
      continue;
    }

    // Still PENDING (not final, or finality unreadable) → CANCEL: release its pending float + budget
    // reserve, single-winner. Count only if THIS call actually cancelled it (the Lua returns 1).
    registerCancelScript(redis);
    const cancelled = await (redis as CancelRedis).cancelAllocation(
      keys.allocation(allocationId),
      keys.floatPending(agentId),
      keys.allocationReserved(orgId),
      keys.pendingAllocations(agentId),
      BigInt(rec.amount ?? '0').toString(),
      allocationId,
    );
    if (cancelled === 1) sweptPending += 1;
  }

  // 2. Reclaim the remaining confirmed float to the treasury (agent-float → treasury). One ledger pair.
  const confirmed = BigInt((await redis.get(keys.floatConfirmed(agentId))) ?? '0');
  let withdrawn = 0n;
  if (confirmed > 0n) {
    await gateway.reclaimFor({ orgId, agentId, amount: confirmed });
    await redis.decrby(keys.floatConfirmed(agentId), confirmed.toString());
    await redis.decrby(keys.allocationCommitted(orgId), confirmed.toString());
    await recordAllocation(pool, {
      allocationId: `teardown_${randomUUID()}`,
      agentId,
      orgId,
      amount: confirmed,
      kind: 'teardown',
      enforcementTimestamp: new Date(now * 1000),
      settlementTimestamp: new Date(now * 1000),
    });
    withdrawn = confirmed;
  }

  // 3. Best-effort WCSPR sweep back to the operator (Task 7). NEVER blocks retire: on any error we
  //    record a residual marker (the operator reclaims out-of-band) and continue. Runs only when the
  //    sweep bundle is present (funding configured + agent has a delegated public key).
  if (params.sweep) {
    try {
      await params.sweep.run({
        agentId,
        agentAccountHash: params.sweep.agentAccountHash,
        agentPublicKeyHex: params.sweep.agentPublicKeyHex,
      });
    } catch (err) {
      // Residual marker: amount left un-swept in the agent account for out-of-band operator reclaim.
      await redis.set(keys.agentSweepResidual(agentId), params.sweep.residualAmountHint ?? '0');
      // eslint-disable-next-line no-console
      console.error('agent WCSPR sweep failed on teardown (residual recorded):', agentId, err);
    }
  }

  return { sweptPending, withdrawn };
}
