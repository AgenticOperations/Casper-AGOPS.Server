import type { Redis } from 'ioredis';
import { keys } from '../../redis/keyspace.js';
import { recordAllocation } from '../ledger/events.js';
import { CONFIRM_ALLOCATION_LUA } from '../../redis/lua/load.js';
import type { ProvisionDeps } from './deposit.js';

/**
 * E5/E6 two-phase float confirm (engine-specs-FINAL.md:178-179, BUG-29/39/42). Promotes a submitted
 * depositFor from `float_pending` (never spendable) to `float_confirmed` (spendable) — but ONLY once the
 * deposit is final on-chain. This mirrors EXPIRY_CHECK's finality discipline: a not-yet-final or failed
 * finality read leaves the deposit PENDING; agentOps never promotes (or frees money) on a blind timeout.
 *
 * Promotion is a single-winner atomic step (the Lua state-check + four counter moves): float_pending →
 * float_confirmed and allocation_reserved → allocation_committed move together, so two concurrent
 * confirmers cannot double-promote. The winner records the cold double-entry pair and clears the in-flight
 * record; a replay is a NOOP. (Phase-1 records synchronously; the audit_outbox+DLQ is the deferred
 * robustness layer, BUG-22/38 — the double-entry + append-only invariants already hold here.)
 */

export type ConfirmResult = 'CONFIRMED' | 'PENDING' | 'NOOP';

interface ConfirmCommands {
  confirmAllocation(
    allocationKey: string,
    floatPendingKey: string,
    floatConfirmedKey: string,
    allocationReservedKey: string,
    allocationCommittedKey: string,
    amount: string,
  ): Promise<number>;
}
type ConfirmRedis = Redis & ConfirmCommands;

const REGISTERED = new WeakSet<Redis>();

/** Idempotently attach the single-winner promotion Lua to a client (ioredis runs it via EVALSHA). */
function registerConfirmScript(redis: Redis): void {
  if (REGISTERED.has(redis)) return;
  redis.defineCommand('confirmAllocation', { numberOfKeys: 5, lua: CONFIRM_ALLOCATION_LUA });
  REGISTERED.add(redis);
}

export async function confirmDeposit(
  deps: ProvisionDeps,
  params: { allocationId: string; now: number },
): Promise<ConfirmResult> {
  const { pool, redis, gateway } = deps;
  const { allocationId, now } = params;
  const key = keys.allocation(allocationId);

  const rec = await redis.hgetall(key);
  if (rec.state !== 'PENDING') return 'NOOP'; // absent or already promoted (idempotent).

  // Finality gate (BUG-39/42): never promote without positive finality. A failed/timed-out read or a
  // not-yet-final operation leaves the deposit PENDING — pending float stays non-spendable until proven.
  let final: boolean;
  try {
    final = await gateway.isFinal(rec.txRef ?? '');
  } catch {
    return 'PENDING';
  }
  if (!final) return 'PENDING';

  const agentId = rec.agentId ?? '';
  const orgId = rec.orgId ?? '';
  const amount = BigInt(rec.amount ?? '0');

  registerConfirmScript(redis);
  const won = await (redis as ConfirmRedis).confirmAllocation(
    key,
    keys.floatPending(agentId),
    keys.floatConfirmed(agentId),
    keys.allocationReserved(orgId),
    keys.allocationCommitted(orgId),
    amount.toString(),
  );
  if (won !== 1) return 'NOOP'; // a concurrent confirmer won the single-winner race.

  // Promotion is terminal for this deposit: drop it from the per-agent in-flight index (L5 teardown sweep).
  await redis.srem(keys.pendingAllocations(agentId), allocationId);

  await recordAllocation(pool, {
    allocationId,
    agentId,
    orgId,
    amount,
    kind: (rec.kind ?? 'depositFor') as 'depositFor' | 'topup' | 'teardown',
    enforcementTimestamp: new Date(Number(rec.submittedAt ?? now) * 1000),
    settlementTimestamp: new Date(now * 1000),
    // On-chain WCSPR funding tx (delegated-key agents; written to the Redis allocation record by
    // depositFor). Persisted so the treasury history can render an explorer link.
    ...(rec.fundTxHash ? { fundTxHash: rec.fundTxHash } : {}),
  });
  await redis.del(key);
  return 'CONFIRMED';
}
