import type pg from 'pg';
import type { PaymentState, Rail } from '../../contracts/index.js';

/**
 * Cold-tier (Postgres) append for the Ledger. Two append-only, double-entry journals plus the
 * per-payment audit row (engine-specs-FINAL.md:147,152,165-166). Every row carries dual timestamps
 * (NFR-01, engine-specs-FINAL.md:151). There is deliberately no UPDATE path: a correction is a new
 * row, never a mutation of a prior one.
 *
 * Phase-1 writes the cold rows synchronously inside the settle/allocate transaction (the RECORD
 * band). The transactional `audit_outbox` + DLQ worker (BUG-22/38) is a later robustness layer; the
 * dual-timestamp + append-only + double-entry invariants are already met here.
 */

export interface SettlementRecord {
  paymentId: string;
  agentId: string;
  orgId: string;
  rail: Rail;
  resourceId: string;
  /** Vendor pay-to address — the credit account of the double-entry pair. */
  destination: string;
  /** Quoted vs actually-charged base units; both recorded for audit (consumed moves the money). */
  requested: bigint;
  consumed: bigint;
  /** The immutable policy version that governed the decision: `policy_…@vN`. */
  policyRef: string;
  reasonCode?: string | null;
  /** QUOTED-time used for all policy math. */
  enforcementTimestamp: Date;
  /** On-chain SETTLED time used for accounting. */
  settlementTimestamp: Date;
}

/**
 * A non-settlement decision: a DENY (or an in-flight QUOTED) audit row. Unlike a settlement it moves
 * no money — one `payment_events` row, no double-entry journal, `consumed = 0`, `settlement_timestamp`
 * NULL. The ALLOW settlement audit row is written later by EXPIRY_CHECK at SETTLED (recordSettlement),
 * so the audit stays append-only and a payment never has two rows for the same outcome.
 */
export interface DecisionRecord {
  paymentId: string;
  agentId: string;
  orgId: string;
  rail: Rail;
  resourceId: string;
  requested: bigint;
  policyRef: string;
  state: PaymentState;
  result: 'ALLOW' | 'DENY';
  reasonCode?: string | null;
  enforcementTimestamp: Date;
}

export async function recordDecision(pool: pg.Pool, record: DecisionRecord): Promise<void> {
  await pool.query(
    `INSERT INTO payment_events
       (payment_id, agent_id, org_id, rail_scheme, rail_chain, resource_id, requested, consumed,
        policy_ref, state, result, reason_code, enforcement_timestamp, settlement_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, $12, NULL)`,
    [
      record.paymentId,
      record.agentId,
      record.orgId,
      record.rail.scheme,
      record.rail.chain,
      record.resourceId,
      record.requested.toString(),
      record.policyRef,
      record.state,
      record.result,
      record.reasonCode ?? null,
      record.enforcementTimestamp,
    ],
  );
}

export interface AllocationRecord {
  allocationId: string;
  agentId: string;
  orgId: string;
  amount: bigint;
  kind: 'depositFor' | 'topup' | 'teardown';
  enforcementTimestamp: Date;
  settlementTimestamp: Date;
}

/**
 * Append a settled spend: one `payment_events` audit row + two balanced `spend_events` rows
 * (debit agent-float, credit the vendor) in a single transaction. The debit and credit carry the
 * same `consumed` amount, so the pair sums to zero per payment.
 */
export async function recordSettlement(pool: pg.Pool, record: SettlementRecord): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO payment_events
         (payment_id, agent_id, org_id, rail_scheme, rail_chain, resource_id, requested, consumed,
          policy_ref, state, result, reason_code, enforcement_timestamp, settlement_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SETTLED', 'ALLOW', $10, $11, $12)`,
      [
        record.paymentId,
        record.agentId,
        record.orgId,
        record.rail.scheme,
        record.rail.chain,
        record.resourceId,
        record.requested.toString(),
        record.consumed.toString(),
        record.policyRef,
        record.reasonCode ?? null,
        record.enforcementTimestamp,
        record.settlementTimestamp,
      ],
    );
    // Double-entry: equal-and-opposite rows for one payment sum to zero (engine-specs-FINAL.md:165-166).
    await client.query(
      `INSERT INTO spend_events
         (payment_id, account, direction, amount, agent_id, org_id, resource_id,
          enforcement_timestamp, settlement_timestamp)
       VALUES ($1, 'agent-float', 'debit',  $2, $3, $4, $5, $6, $7),
              ($1, $8,            'credit', $2, $3, $4, $5, $6, $7)`,
      [
        record.paymentId,
        record.consumed.toString(),
        record.agentId,
        record.orgId,
        record.resourceId,
        record.enforcementTimestamp,
        record.settlementTimestamp,
        record.destination,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Append an allocation: two balanced `allocation_events` rows grouped by `allocation_id`, in a single
 * transaction. The direction follows the flow of funds, so the cold ledger reads true in both directions:
 * a depositFor/topup moves treasury → agent-float (debit treasury, credit agent-float); a teardown reclaims
 * agent-float → treasury (debit agent-float, credit treasury). The pair always sums to zero per id.
 * AllocationEvent (C-5) carries `kind`, never a payment_id.
 */
export async function recordAllocation(pool: pg.Pool, record: AllocationRecord): Promise<void> {
  const client = await pool.connect();
  const fundsLeaveTreasury = record.kind !== 'teardown';
  const debitAccount = fundsLeaveTreasury ? 'treasury' : 'agent-float';
  const creditAccount = fundsLeaveTreasury ? 'agent-float' : 'treasury';
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO allocation_events
         (allocation_id, kind, account, direction, amount, agent_id, org_id,
          enforcement_timestamp, settlement_timestamp)
       VALUES ($1, $2, $8, 'debit',  $3, $4, $5, $6, $7),
              ($1, $2, $9, 'credit', $3, $4, $5, $6, $7)`,
      [
        record.allocationId,
        record.kind,
        record.amount.toString(),
        record.agentId,
        record.orgId,
        record.enforcementTimestamp,
        record.settlementTimestamp,
        debitAccount,
        creditAccount,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
