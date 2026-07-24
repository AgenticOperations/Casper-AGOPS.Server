import type pg from 'pg';

/**
 * Group C (doc 05 §6.4, §9): read-only statements + the immutable audit-log export over the append-only
 * cold ledger (M3). NO write path — a correction is a new ledger row, never a mutation. Every money value
 * crosses the wire as a base-unit STRING; `numeric(78,0)` sums are cast `::text`, counts `::int`.
 *
 * AgentOps decisions live in `casper_guard_decisions` (separate table — the Phase-1 payment_events
 * rail_scheme CHECK constrains it to Arc/Solana rails). Statement and audit queries UNION both tables so
 * all settled spend is visible regardless of rail.
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

/** One row in the unified spend breakdown: agent × service × rail. */
export interface StatementLine {
  agent_id: string;
  resource_id: string;
  rail_scheme: string;
  rail_chain: string;
  count: number;
  amount: string;
}
export interface StatementTotals {
  settled_count: number;
  settled_amount: string;
  denied_count: number;
  audit_count: number;
}
export interface Statement {
  period: ResolvedPeriod;
  totals: StatementTotals;
  lines: StatementLine[];
}

/** Period spend statement for one org: settled totals + DENY count + per agent/service/rail breakdowns.
 *  UNIONs payment_events (Arc/Solana rails) with casper_guard_decisions (AgentOps rails). */
export async function readStatement(
  pool: pg.Pool,
  orgId: string,
  period: ResolvedPeriod,
  network?: string,
): Promise<Statement> {
  const args: unknown[] = [orgId, period.from, period.to];
  // Casper network fence: when a network is requested, casper_guard_decisions rows are restricted to
  // it ($4). payment_events (Arc/Solana/x402 — non-Casper rails) are always included, since the Casper
  // toggle does not apply to them. Absent network → no fence (shows everything, as before the toggle).
  const CG_NET = network ? `AND network = $${args.push(network)}` : '';

  // payment_events settled filter
  const PE_SETTLED = `result = 'ALLOW' AND settlement_timestamp IS NOT NULL
    AND settlement_timestamp >= $2 AND settlement_timestamp < $3`;
  const PE_DENIED = `result = 'DENY' AND enforcement_timestamp >= $2 AND enforcement_timestamp < $3`;

  // casper_guard_decisions settled filter: status=SETTLED means outcome=ALLOW + on-chain confirmed.
  const CG_SETTLED = `status = 'SETTLED' AND updated_at >= $2 AND updated_at < $3 ${CG_NET}`;
  const CG_DENIED  = `outcome = 'DENY' AND created_at >= $2 AND created_at < $3 ${CG_NET}`;
  // Audit count over casper_guard_decisions also respects the network fence.
  const CG_AUDIT = `created_at >= $2 AND created_at < $3 ${CG_NET}`;

  const totals = await pool.query<{
    settled_count: number; settled_amount: string; denied_count: number; audit_count: number;
  }>(
    `SELECT
       (
         (SELECT count(*)::int FROM payment_events WHERE org_id = $1 AND ${PE_SETTLED})
         + (SELECT count(*)::int FROM casper_guard_decisions WHERE org_id = $1 AND ${CG_SETTLED})
       ) AS settled_count,
       (
         COALESCE((SELECT SUM(consumed) FROM payment_events WHERE org_id = $1 AND ${PE_SETTLED}), 0)
         + COALESCE((SELECT SUM(amount) FROM casper_guard_decisions WHERE org_id = $1 AND ${CG_SETTLED}), 0)
       )::text AS settled_amount,
       (
         (SELECT count(*)::int FROM payment_events WHERE org_id = $1 AND ${PE_DENIED})
         + (SELECT count(*)::int FROM casper_guard_decisions WHERE org_id = $1 AND ${CG_DENIED})
       ) AS denied_count,
       (
         (SELECT count(*)::int FROM payment_events WHERE org_id = $1 AND enforcement_timestamp >= $2 AND enforcement_timestamp < $3)
         + (SELECT count(*)::int FROM casper_guard_decisions WHERE org_id = $1 AND ${CG_AUDIT})
       ) AS audit_count`,
    args,
  );

  const lines = await pool.query<StatementLine>(
    `SELECT agent_id, resource_id, rail_scheme, rail_chain,
            count(*)::int AS count, COALESCE(SUM(amount), 0)::text AS amount
     FROM (
       SELECT agent_id, resource_id, rail_scheme, rail_chain, consumed::numeric AS amount
       FROM payment_events
       WHERE org_id = $1 AND ${PE_SETTLED}
       UNION ALL
       SELECT agent_id, resource_id, action_kind AS rail_scheme, network AS rail_chain, amount::numeric
       FROM casper_guard_decisions
       WHERE org_id = $1 AND ${CG_SETTLED}
     ) t
     GROUP BY agent_id, resource_id, rail_scheme, rail_chain
     ORDER BY SUM(amount) DESC, agent_id ASC, resource_id ASC`,
    args,
  );

  return {
    period,
    totals: totals.rows[0] ?? { settled_count: 0, settled_amount: '0', denied_count: 0, audit_count: 0 },
    lines: lines.rows,
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
  /** On-chain tx or deploy hash, present for AgentOps settled rows. */
  tx_hash?: string | null;
}

/** Raw pg driver shape: `timestamptz` comes back as a `Date`; money is already a string via the `::text` cast. */
type RawAuditRow = Omit<AuditRow, 'enforcement_timestamp' | 'settlement_timestamp'> & {
  enforcement_timestamp: Date;
  settlement_timestamp: Date | null;
};

/** The immutable per-payment audit rows for the period, oldest first (export order).
 *  UNIONs payment_events (Arc/Solana) and casper_guard_decisions (AgentOps). */
export async function readAuditLog(
  pool: pg.Pool,
  orgId: string,
  period: ResolvedPeriod,
  limit: number,
  network?: string,
): Promise<AuditRow[]> {
  const params: unknown[] = [orgId, period.from, period.to, limit];
  // Same Casper fence as readStatement: restrict casper_guard_decisions to the requested network
  // ($5) while leaving payment_events (non-Casper) unfiltered. Absent → no fence.
  const CG_NET = network ? `AND network = $${params.push(network)}` : '';
  const res = await pool.query<RawAuditRow>(
    `SELECT payment_id, agent_id, resource_id, rail_scheme, rail_chain,
            requested, consumed, policy_ref, state, result, reason_code,
            enforcement_timestamp, settlement_timestamp, tx_hash
     FROM (
       SELECT payment_id, agent_id, resource_id, rail_scheme, rail_chain,
              requested::text AS requested, consumed::text AS consumed,
              policy_ref, state, result, reason_code,
              enforcement_timestamp, settlement_timestamp,
              NULL::text AS tx_hash
       FROM payment_events
       WHERE org_id = $1 AND enforcement_timestamp >= $2 AND enforcement_timestamp < $3

       UNION ALL

       SELECT decision_id AS payment_id, agent_id, resource_id,
              action_kind AS rail_scheme, network AS rail_chain,
              amount::text AS requested, amount::text AS consumed,
              policy_ref,
              status AS state,
              outcome AS result,
              reason_code,
              created_at AS enforcement_timestamp,
              CASE WHEN status = 'SETTLED' THEN updated_at ELSE NULL END AS settlement_timestamp,
              COALESCE(tx_hash, deploy_hash) AS tx_hash
       FROM casper_guard_decisions
       WHERE org_id = $1 AND created_at >= $2 AND created_at < $3 ${CG_NET}
     ) combined
     ORDER BY enforcement_timestamp ASC, payment_id ASC
     LIMIT $4`,
    params,
  );
  return res.rows.map((r) => ({
    ...r,
    enforcement_timestamp: r.enforcement_timestamp.toISOString(),
    settlement_timestamp: r.settlement_timestamp ? r.settlement_timestamp.toISOString() : null,
  }));
}
