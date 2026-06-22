import type pg from 'pg';

/**
 * Group C (doc 05 §6.4, §9): read-only statements + the immutable audit-log export over the append-only
 * cold ledger (M3). NO write path — a correction is a new ledger row, never a mutation. Every money value
 * crosses the wire as a base-unit STRING; `numeric(78,0)` sums are cast `::text`, counts `::int`.
 */

export type PeriodLabel = '7d' | '30d' | 'all';
export interface ResolvedPeriod {
  from: string; // ISO-8601, inclusive lower bound
  to: string; // ISO-8601, exclusive upper bound
  label: PeriodLabel;
}

const PERIOD_DAYS: Record<Exclude<PeriodLabel, 'all'>, number> = { '7d': 7, '30d': 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Resolve a period token to an explicit [from, to) window against an injected `now` (deterministic/testable). */
export function resolvePeriod(period: string | undefined, now: Date): ResolvedPeriod {
  const label: PeriodLabel = period === '7d' || period === 'all' ? period : '30d';
  const to = now.toISOString();
  if (label === 'all') return { from: new Date(0).toISOString(), to, label };
  const from = new Date(now.getTime() - PERIOD_DAYS[label] * DAY_MS).toISOString();
  return { from, to, label };
}

export interface StatementGroupAgent { agent_id: string; count: number; amount: string }
export interface StatementGroupService { resource_id: string; count: number; amount: string }
export interface StatementGroupRail { rail_scheme: string; rail_chain: string; count: number; amount: string }
export interface StatementTotals {
  settled_count: number;
  settled_amount: string;
  denied_count: number;
  audit_count: number;
}
export interface Statement {
  period: ResolvedPeriod;
  totals: StatementTotals;
  by_agent: StatementGroupAgent[];
  by_service: StatementGroupService[];
  by_rail: StatementGroupRail[];
}

const SETTLED = `result = 'ALLOW' AND settlement_timestamp IS NOT NULL`;

/** Period spend statement for one org: settled totals + DENY count + per agent/service/rail breakdowns. */
export async function readStatement(pool: pg.Pool, orgId: string, period: ResolvedPeriod): Promise<Statement> {
  const args = [orgId, period.from, period.to];
  const totals = await pool.query<{
    settled_count: number; settled_amount: string; denied_count: number; audit_count: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE ${SETTLED} AND settlement_timestamp >= $2 AND settlement_timestamp < $3)::int AS settled_count,
       COALESCE(SUM(consumed) FILTER (WHERE ${SETTLED} AND settlement_timestamp >= $2 AND settlement_timestamp < $3), 0)::text AS settled_amount,
       count(*) FILTER (WHERE result = 'DENY' AND enforcement_timestamp >= $2 AND enforcement_timestamp < $3)::int AS denied_count,
       count(*) FILTER (WHERE enforcement_timestamp >= $2 AND enforcement_timestamp < $3)::int AS audit_count
     FROM payment_events WHERE org_id = $1`,
    args,
  );

  const byAgent = await pool.query<StatementGroupAgent>(
    `SELECT agent_id, count(*)::int AS count, COALESCE(SUM(consumed), 0)::text AS amount
     FROM payment_events
     WHERE org_id = $1 AND ${SETTLED} AND settlement_timestamp >= $2 AND settlement_timestamp < $3
     GROUP BY agent_id ORDER BY SUM(consumed) DESC, agent_id ASC`,
    args,
  );
  const byService = await pool.query<StatementGroupService>(
    `SELECT resource_id, count(*)::int AS count, COALESCE(SUM(consumed), 0)::text AS amount
     FROM payment_events
     WHERE org_id = $1 AND ${SETTLED} AND settlement_timestamp >= $2 AND settlement_timestamp < $3
     GROUP BY resource_id ORDER BY SUM(consumed) DESC, resource_id ASC`,
    args,
  );
  const byRail = await pool.query<StatementGroupRail>(
    `SELECT rail_scheme, rail_chain, count(*)::int AS count, COALESCE(SUM(consumed), 0)::text AS amount
     FROM payment_events
     WHERE org_id = $1 AND ${SETTLED} AND settlement_timestamp >= $2 AND settlement_timestamp < $3
     GROUP BY rail_scheme, rail_chain ORDER BY SUM(consumed) DESC, rail_scheme ASC`,
    args,
  );

  return {
    period,
    totals: totals.rows[0] ?? { settled_count: 0, settled_amount: '0', denied_count: 0, audit_count: 0 },
    by_agent: byAgent.rows,
    by_service: byService.rows,
    by_rail: byRail.rows,
  };
}

export interface AuditRow {
  payment_id: string;
  agent_id: string;
  resource_id: string;
  rail_scheme: string;
  rail_chain: string;
  requested: string;
  consumed: string;
  policy_ref: string;
  state: string;
  result: string;
  reason_code: string | null;
  enforcement_timestamp: string;
  settlement_timestamp: string | null;
}

/** Raw pg driver shape: `timestamptz` comes back as a `Date`; money is already a string via the `::text` cast. */
type RawAuditRow = Omit<AuditRow, 'enforcement_timestamp' | 'settlement_timestamp'> & {
  enforcement_timestamp: Date;
  settlement_timestamp: Date | null;
};

/** The immutable per-payment audit rows for the period, oldest first (export order). Append-only by construction. */
export async function readAuditLog(
  pool: pg.Pool,
  orgId: string,
  period: ResolvedPeriod,
  limit: number,
): Promise<AuditRow[]> {
  const res = await pool.query<RawAuditRow>(
    `SELECT payment_id, agent_id, resource_id, rail_scheme, rail_chain,
            requested::text AS requested, consumed::text AS consumed,
            policy_ref, state, result, reason_code, enforcement_timestamp, settlement_timestamp
     FROM payment_events
     WHERE org_id = $1 AND enforcement_timestamp >= $2 AND enforcement_timestamp < $3
     ORDER BY enforcement_timestamp ASC, payment_id ASC
     LIMIT $4`,
    [orgId, period.from, period.to, limit],
  );
  return res.rows.map((r) => ({
    ...r,
    enforcement_timestamp: r.enforcement_timestamp.toISOString(),
    settlement_timestamp: r.settlement_timestamp ? r.settlement_timestamp.toISOString() : null,
  }));
}
