import type { Redis } from 'ioredis';
import type pg from 'pg';
import { keys } from '../../redis/keyspace.js';
import { computeSpendable } from '../custody/balance.js';
import type { CasperScopedNetwork } from '../casper-guard/network-header.js';

export interface TreasuryReadDeps { redis: Redis; pool: pg.Pool; }

export interface TreasuryBalances {
  available: string;
  allocation_committed: string;
  allocation_reserved: string;
  allocated: string;
  free: string;
}

/**
 * Unified org balance (doc 05 §6.1): available, allocated = committed + reserved,
 * free = available − allocated (clamped ≥0). All base-unit strings.
 *
 * `available` is the sum of THIS org's credited deposits from the treasury_deposit_intents ledger —
 * NOT the operator wallet's on-chain balance. The operator wallet is a single shared custodial account
 * that pools every org's deposits, so its raw balance is a cross-tenant total and must never be shown
 * as one org's balance. The per-org ledger is the tenant-isolated source of truth (each deposit-by-hash
 * / verify-deposit credit writes a row keyed on org_id).
 */
export async function getTreasuryBalances(
  deps: TreasuryReadDeps,
  orgId: string,
  network: CasperScopedNetwork,
): Promise<TreasuryBalances> {
  const { redis, pool } = deps;
  const [depositRes, committedRaw, reservedRaw] = await Promise.all([
    pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(credited_amount), 0)::text AS total
         FROM treasury_deposit_intents
        WHERE org_id = $1 AND status = 'credited' AND network = $2`,
      [orgId, network],
    ),
    redis.get(keys.allocationCommitted(orgId)),
    redis.get(keys.allocationReserved(orgId)),
  ]);
  const available = BigInt(depositRes.rows[0]?.total ?? '0');
  const committed = BigInt(committedRaw ?? '0');
  const reserved = BigInt(reservedRaw ?? '0');
  const allocated = committed + reserved;
  const free = available - allocated > 0n ? available - allocated : 0n;
  return {
    available: available.toString(),
    allocation_committed: committed.toString(),
    allocation_reserved: reserved.toString(),
    allocated: allocated.toString(),
    free: free.toString(),
  };
}

export interface AgentFloatRow {
  id: string; name: string; status: string;
  float_pending: string; float_confirmed: string;
  consumed: string; reserved: string; spendable: string;
}

/**
 * Per-agent float table (doc 05 §6.1). Agents from Postgres (status), counters from Redis.
 * MVP simplification (logged, not silent): escrowReserved is per-escrow, not aggregated per-agent, so it is
 * treated as 0 here. spendable = floatConfirmed − consumed − reserved. The killer-cell demo does not
 * exercise multi-escrow holds; post-MVP must aggregate the agent's open escrow reserves before display.
 */
export async function listAgentsWithFloats(pool: pg.Pool, redis: Redis, orgId: string): Promise<AgentFloatRow[]> {
  const res = await pool.query<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE org_id = $1 ORDER BY created_at ASC',
    [orgId],
  );
  const rows: AgentFloatRow[] = [];
  for (const a of res.rows) {
    const [fp, fc, c, r] = await Promise.all([
      redis.get(keys.floatPending(a.id)),
      redis.get(keys.floatConfirmed(a.id)),
      redis.get(keys.consumed(a.id)),
      redis.get(keys.reserved(a.id)),
    ]);
    const floatConfirmed = BigInt(fc ?? '0');
    const consumed = BigInt(c ?? '0');
    const reserved = BigInt(r ?? '0');
    const spendable = computeSpendable({ floatConfirmed, consumed, reserved, escrowReserved: 0n });
    rows.push({
      id: a.id, name: a.name, status: a.status,
      float_pending: BigInt(fp ?? '0').toString(),
      float_confirmed: floatConfirmed.toString(),
      consumed: consumed.toString(),
      reserved: reserved.toString(),
      spendable: spendable.toString(),
    });
  }
  return rows;
}

export interface TreasuryHistoryRow {
  allocation_id: string;
  kind: string;
  agent_id: string;
  amount: string;
  settlement_timestamp: string;
  recorded_at: string;
}

/**
 * Deposit + top-up history (doc 05 §6.1). One row per allocation = the agent-float credit leg.
 * Newest first. Excludes teardown rows — caller only wants inbound allocations.
 */
interface AllocationEventRow {
  allocation_id: string;
  kind: string;
  agent_id: string;
  amount: string;
  settlement_timestamp: Date;
  recorded_at: Date;
}

export async function listTreasuryHistory(pool: pg.Pool, orgId: string, limit = 100): Promise<TreasuryHistoryRow[]> {
  const res = await pool.query<AllocationEventRow>(
    `SELECT allocation_id, kind, agent_id, amount::text AS amount, settlement_timestamp, recorded_at
       FROM allocation_events
      WHERE org_id = $1 AND account = 'agent-float' AND direction = 'credit' AND kind IN ('depositFor','topup')
      ORDER BY recorded_at DESC
      LIMIT $2`,
    [orgId, limit],
  );
  return res.rows.map((r) => ({
    allocation_id: r.allocation_id,
    kind: r.kind,
    agent_id: r.agent_id,
    amount: r.amount,
    settlement_timestamp: new Date(r.settlement_timestamp).toISOString(),
    recorded_at: new Date(r.recorded_at).toISOString(),
  }));
}

/**
 * Cooldown input for depositFor (doc 05 §6.1): seconds elapsed since this agent's last
 * depositFor/topup enforcement timestamp, or null if this agent has never been allocated.
 */
export async function secondsSinceLastAllocation(pool: pg.Pool, agentId: string, now: number): Promise<number | null> {
  const res = await pool.query<{ enforcement_timestamp: Date }>(
    `SELECT enforcement_timestamp FROM allocation_events
      WHERE agent_id = $1 AND account = 'agent-float' AND direction = 'credit' AND kind IN ('depositFor','topup')
      ORDER BY enforcement_timestamp DESC LIMIT 1`,
    [agentId],
  );
  const last = res.rows[0];
  if (!last) return null;
  return now - Math.floor(new Date(last.enforcement_timestamp).getTime() / 1000);
}
