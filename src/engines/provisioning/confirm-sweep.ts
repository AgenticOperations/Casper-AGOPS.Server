import { keys } from '../../redis/keyspace.js';
import { confirmDeposit } from './confirm.js';
import type { ProvisionDeps } from './deposit.js';

/**
 * Background confirmation sweep (operator decision 2026-06-20). `confirmDeposit` is the SINGLE finality
 * authority and is idempotent (NOOP when terminal, PENDING when not yet final) — so this sweep is safe to
 * run on every tick. PURE function: the worker (confirm-worker.ts) is the only timing shell. Enumerates
 * agents from Postgres (system of record), reads each agent's in-flight index, and tries to promote each.
 *
 * MVP scope: unbounded SELECT over all agents (single-operator demo). Pagination/cursoring is post-MVP —
 * logged here, not silently capped.
 */

export interface SweepResult {
  scanned: number;
  confirmed: number;
  pending: number;
  noop: number;
}

export async function sweepPendingConfirmations(
  deps: ProvisionDeps,
  params: { now: number },
): Promise<SweepResult> {
  const { pool, redis } = deps;
  const { now } = params;
  const agents = await pool.query<{ id: string }>('SELECT id FROM agents');
  const result: SweepResult = { scanned: 0, confirmed: 0, pending: 0, noop: 0 };
  for (const { id: agentId } of agents.rows) {
    const ids = await redis.smembers(keys.pendingAllocations(agentId));
    for (const allocationId of ids) {
      result.scanned += 1;
      const outcome = await confirmDeposit(deps, { allocationId, now });
      if (outcome === 'CONFIRMED') result.confirmed += 1;
      else if (outcome === 'PENDING') result.pending += 1;
      else result.noop += 1;
    }
  }
  return result;
}
