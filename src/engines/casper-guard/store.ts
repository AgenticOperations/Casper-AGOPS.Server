import type pg from 'pg';
import {
  casperGuardAssetRef,
  casperGuardIntentDestination,
  casperGuardIntentPrimaryAsset,
  type CasperGuardActionKind,
  type CasperGuardDecisionStatus,
  type CasperGuardIntent,
} from './types.js';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface CreateCasperGuardDecisionInput {
  decisionId: string;
  idempotencyKey: string;
  orgId: string;
  agentId: string;
  intent: CasperGuardIntent;
  status: CasperGuardDecisionStatus;
  outcome: 'ALLOW' | 'DENY';
  policyRef: string;
  reasonCode?: string | null;
  signerKind?: string | null;
  rawRequirementHash?: string | null;
  signedHeaderHash?: string | null;
  txHash?: string | null;
  deployHash?: string | null;
}

export interface CreateCasperGuardHoldInput {
  holdId: string;
  decisionId: string;
  orgId: string;
  agentId: string;
  amount: string;
  assetKind: 'cep18' | 'native' | 'native-eth' | 'erc20';
  assetRef: string;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED';
  network: string;
}

export interface AppendCasperGuardReconciliationAttemptInput {
  decisionId: string;
  attemptNumber: number;
  source: 'facilitator' | 'casper-rpc' | 'cspr-cloud' | 'operator-wallet';
  status: 'pending' | 'settled' | 'failed' | 'ambiguous';
  evidence: Record<string, unknown>;
  errorCode?: string | null;
  network: string;
}

export interface AppendCasperGuardAuditAnchorInput {
  anchorId: string;
  decisionId: string;
  anchorKind: 'odra-guard-registry';
  decisionHash: string;
  status: 'submitted' | 'confirmed' | 'failed';
  txHash?: string | null;
  network: string;
}

export interface ClaimCasperGuardAuditAnchorInput {
  anchorId: string;
  decisionId: string;
  decisionHash: string;
  staleSubmittedMs: number;
  network: string;
}

export interface CasperGuardDecisionRecord {
  decisionId: string;
  idempotencyKey: string;
  orgId: string;
  agentId: string;
  actionKind: CasperGuardActionKind;
  network: string;
  resourceId: string;
  amount: string;
  assetKind: 'cep18' | 'native' | 'native-eth' | 'erc20';
  assetRef: string;
  destination: string | null;
  status: CasperGuardDecisionStatus;
  outcome: 'ALLOW' | 'DENY';
  reasonCode: string | null;
  policyRef: string;
  signerKind: string | null;
  rawRequirementHash: string | null;
  signedHeaderHash: string | null;
  signedHeaderValue: string | null;
  txHash: string | null;
  deployHash: string | null;
  intent: CasperGuardIntent;
  hold: CasperGuardHoldRecord | null;
  reconciliationAttempts: CasperGuardReconciliationAttemptRecord[];
  auditAnchors: CasperGuardAuditAnchorRecord[];
}

export interface CasperGuardHoldRecord {
  holdId: string;
  amount: string;
  assetKind: 'cep18' | 'native' | 'native-eth' | 'erc20';
  assetRef: string;
  status: 'RESERVED' | 'SETTLED' | 'RELEASED';
  network: string;
}

export interface CasperGuardReconciliationAttemptRecord {
  attemptNumber: number;
  source: string;
  status: string;
  evidence: Record<string, unknown>;
  errorCode: string | null;
}

export interface CasperGuardAuditAnchorRecord {
  anchorId: string;
  anchorKind: string;
  decisionHash: string;
  status: string;
  txHash: string | null;
}

export async function markCasperGuardDecisionSigned(
  pool: pg.Pool,
  input: {
    decisionId: string;
    signedHeaderHash: string;
    signedHeaderValue?: string | null;
    txHash?: string | null;
    deployHash?: string | null;
  },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_decisions
        SET status = 'SIGNED',
            signed_header_hash = $2,
            signed_header_value = COALESCE($3, signed_header_value),
            tx_hash = COALESCE($4, tx_hash),
            deploy_hash = COALESCE($5, deploy_hash),
            updated_at = now()
      WHERE decision_id = $1
        AND status = 'RESERVED'
        AND outcome = 'ALLOW'
        AND EXISTS (
          SELECT 1
            FROM casper_guard_holds
           WHERE decision_id = $1
             AND status = 'RESERVED'
        )`,
    [input.decisionId, input.signedHeaderHash, input.signedHeaderValue ?? null, input.txHash ?? null, input.deployHash ?? null],
  );
  return result.rowCount === 1;
}

export async function markCasperGuardDecisionTerminal(
  pool: pg.Pool,
  input: { decisionId: string; status: 'FAILED_TERMINAL' | 'EXPIRED' },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_decisions
        SET status = $2,
            updated_at = now()
      WHERE decision_id = $1
        AND status NOT IN ('DENIED', 'SETTLED', 'FAILED_TERMINAL', 'EXPIRED')`,
    [input.decisionId, input.status],
  );
  return result.rowCount === 1;
}

export async function markCasperGuardDecisionExpiryCheck(
  pool: pg.Pool,
  decisionId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_decisions
        SET status = 'EXPIRY_CHECK',
            updated_at = now()
      WHERE decision_id = $1
        AND status IN ('SIGNED', 'BROADCASTING')
        AND outcome = 'ALLOW'
        AND signed_header_hash IS NOT NULL`,
    [decisionId],
  );
  return result.rowCount === 1;
}

export async function markCasperGuardDecisionSettled(
  pool: pg.Pool,
  input: { decisionId: string; txHash?: string | null; deployHash?: string | null },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_decisions
        SET status = 'SETTLED',
            tx_hash = COALESCE($2, tx_hash),
            deploy_hash = COALESCE($3, deploy_hash),
            updated_at = now()
      WHERE decision_id = $1
        AND status IN ('SIGNED', 'BROADCASTING', 'EXPIRY_CHECK')
        AND outcome = 'ALLOW'
        AND signed_header_hash IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM casper_guard_holds
           WHERE decision_id = $1
             AND status = 'RESERVED'
        )`,
    [input.decisionId, input.txHash ?? null, input.deployHash ?? null],
  );
  return result.rowCount === 1;
}

/**
 * Settle a decision that is still RESERVED because the user broadcast the tx themselves.
 * The normal FSM path (SIGNED → BROADCASTING → EXPIRY_CHECK → SETTLED) is bypassed —
 * the user provided the tx_hash directly so we go straight to SETTLED.
 */
export async function markDecisionSettledByUser(
  pool: pg.Pool,
  input: { decisionId: string; txHash: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_decisions
        SET status = 'SETTLED',
            tx_hash = $2,
            deploy_hash = $2,
            updated_at = now()
      WHERE decision_id = $1
        AND status IN ('RESERVED', 'SIGNED')
        AND outcome = 'ALLOW'
        AND EXISTS (
          SELECT 1
            FROM casper_guard_holds
           WHERE decision_id = $1
             AND status = 'RESERVED'
        )`,
    [input.decisionId, input.txHash],
  );
  return result.rowCount === 1;
}

export async function settleCasperGuardHold(pool: pg.Pool, decisionId: string): Promise<boolean> {
  const result = await pool.query<{ hold_id: string }>(
    `UPDATE casper_guard_holds
        SET status = 'SETTLED',
            resolved_at = COALESCE(resolved_at, now())
      WHERE decision_id = $1
        AND status = 'RESERVED'
      RETURNING hold_id`,
    [decisionId],
  );
  return result.rowCount === 1;
}

export async function releaseCasperGuardHold(pool: pg.Pool, decisionId: string): Promise<boolean> {
  const result = await pool.query<{ hold_id: string }>(
    `UPDATE casper_guard_holds
        SET status = 'RELEASED',
            resolved_at = COALESCE(resolved_at, now())
      WHERE decision_id = $1
        AND status = 'RESERVED'
      RETURNING hold_id`,
    [decisionId],
  );
  return result.rowCount === 1;
}

export async function createCasperGuardDecision(
  pool: pg.Pool,
  input: CreateCasperGuardDecisionInput,
): Promise<void> {
  await insertCasperGuardDecision(pool, input);
}

export async function createCasperGuardDecisionAndHold(
  pool: pg.Pool,
  decision: CreateCasperGuardDecisionInput,
  hold: CreateCasperGuardHoldInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertCasperGuardDecision(client, decision);
    await insertCasperGuardHold(client, hold);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertCasperGuardDecision(
  db: Queryable,
  input: CreateCasperGuardDecisionInput,
): Promise<void> {
  const asset = casperGuardIntentPrimaryAsset(input.intent);
  await db.query(
    `INSERT INTO casper_guard_decisions
       (decision_id, idempotency_key, org_id, agent_id, action_kind, network, resource_id,
        amount, asset_kind, asset_ref, destination, status, outcome, reason_code, policy_ref,
        signer_kind, raw_requirement_hash, signed_header_hash, tx_hash, deploy_hash, intent_json)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21)`,
    [
      input.decisionId,
      input.idempotencyKey,
      input.orgId,
      input.agentId,
      input.intent.kind,
      input.intent.network,
      input.intent.resourceId,
      input.intent.amount,
      asset.kind,
      casperGuardAssetRef(asset),
      casperGuardIntentDestination(input.intent),
      input.status,
      input.outcome,
      input.reasonCode ?? null,
      input.policyRef,
      input.signerKind ?? null,
      input.rawRequirementHash ?? rawRequirementHashFromIntent(input.intent),
      input.signedHeaderHash ?? null,
      input.txHash ?? null,
      input.deployHash ?? null,
      JSON.stringify(input.intent),
    ],
  );
}

export async function createCasperGuardHold(
  pool: pg.Pool,
  input: CreateCasperGuardHoldInput,
): Promise<void> {
  await insertCasperGuardHold(pool, input);
}

async function insertCasperGuardHold(db: Queryable, input: CreateCasperGuardHoldInput): Promise<void> {
  await db.query(
    `INSERT INTO casper_guard_holds
       (hold_id, decision_id, org_id, agent_id, amount, asset_kind, asset_ref, status, network)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.holdId,
      input.decisionId,
      input.orgId,
      input.agentId,
      input.amount,
      input.assetKind,
      input.assetRef,
      input.status,
      input.network,
    ],
  );
}

export async function appendCasperGuardReconciliationAttempt(
  pool: pg.Pool,
  input: AppendCasperGuardReconciliationAttemptInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO casper_guard_reconciliation_attempts
       (decision_id, attempt_number, source, status, evidence, error_code, network)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.decisionId,
      input.attemptNumber,
      input.source,
      input.status,
      JSON.stringify(input.evidence),
      input.errorCode ?? null,
      input.network,
    ],
  );
}

export async function appendCasperGuardAuditAnchor(
  pool: pg.Pool,
  input: AppendCasperGuardAuditAnchorInput,
): Promise<void> {
  await pool.query(
    `INSERT INTO casper_guard_audit_anchors
       (anchor_id, decision_id, anchor_kind, decision_hash, status, tx_hash, network)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.anchorId,
      input.decisionId,
      input.anchorKind,
      input.decisionHash,
      input.status,
      input.txHash ?? null,
      input.network,
    ],
  );
}

export async function claimCasperGuardAuditAnchor(
  pool: pg.Pool,
  input: ClaimCasperGuardAuditAnchorInput,
): Promise<string | null> {
  const result = await pool.query<{ anchor_id: string }>(
    `INSERT INTO casper_guard_audit_anchors
       (anchor_id, decision_id, anchor_kind, decision_hash, status, tx_hash, network)
     VALUES ($1, $2, 'odra-guard-registry', $3, 'submitted', NULL, $5)
     ON CONFLICT (decision_id, anchor_kind, decision_hash) DO UPDATE
       SET anchor_id = casper_guard_audit_anchors.anchor_id,
           status = 'submitted',
           tx_hash = NULL,
           anchored_at = now()
       WHERE casper_guard_audit_anchors.status = 'failed'
          OR (
            casper_guard_audit_anchors.status = 'submitted'
            AND casper_guard_audit_anchors.anchored_at < now() - ($4::integer * interval '1 millisecond')
          )
     RETURNING anchor_id`,
    [input.anchorId, input.decisionId, input.decisionHash, input.staleSubmittedMs, input.network],
  );
  return result.rows[0]?.anchor_id ?? null;
}

export async function confirmCasperGuardAuditAnchor(
  pool: pg.Pool,
  input: { anchorId: string; txHash: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_audit_anchors
        SET status = 'confirmed',
            tx_hash = $2,
            anchored_at = now()
      WHERE anchor_id = $1
        AND status = 'submitted'`,
    [input.anchorId, input.txHash],
  );
  return result.rowCount === 1;
}

export async function failCasperGuardAuditAnchor(pool: pg.Pool, anchorId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE casper_guard_audit_anchors
        SET status = 'failed',
            anchored_at = now()
      WHERE anchor_id = $1
        AND status = 'submitted'`,
    [anchorId],
  );
  return result.rowCount === 1;
}

export async function readCasperGuardDecision(
  pool: pg.Pool,
  decisionId: string,
): Promise<CasperGuardDecisionRecord | null> {
  return readCasperGuardDecisionBy(pool, 'decision_id = $1', [decisionId]);
}

export async function readCasperGuardDecisionByIdempotency(
  pool: pg.Pool,
  input: { orgId: string; idempotencyKey: string },
): Promise<CasperGuardDecisionRecord | null> {
  return readCasperGuardDecisionBy(pool, 'org_id = $1 AND idempotency_key = $2', [
    input.orgId,
    input.idempotencyKey,
  ]);
}

async function readCasperGuardDecisionBy(
  pool: pg.Pool,
  whereClause: string,
  values: unknown[],
): Promise<CasperGuardDecisionRecord | null> {
  const decision = await pool.query<CasperGuardDecisionRow>(
    `SELECT decision_id, idempotency_key, org_id, agent_id, action_kind, network, resource_id,
            amount::text, asset_kind, asset_ref, destination, status, outcome, reason_code,
            policy_ref, signer_kind, raw_requirement_hash, signed_header_hash, signed_header_value,
            tx_hash, deploy_hash, intent_json
       FROM casper_guard_decisions
      WHERE ${whereClause}
      ORDER BY created_at ASC
      LIMIT 1`,
    values,
  );
  const row = decision.rows[0];
  if (!row) return null;

  const [hold, attempts, anchors] = await Promise.all([
    readHold(pool, row.decision_id),
    readReconciliationAttempts(pool, row.decision_id),
    readAuditAnchors(pool, row.decision_id),
  ]);

  return {
    decisionId: row.decision_id,
    idempotencyKey: row.idempotency_key,
    orgId: row.org_id,
    agentId: row.agent_id,
    actionKind: row.action_kind,
    network: row.network,
    resourceId: row.resource_id,
    amount: row.amount,
    assetKind: row.asset_kind,
    assetRef: row.asset_ref,
    destination: row.destination,
    status: row.status,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    policyRef: row.policy_ref,
    signerKind: row.signer_kind,
    rawRequirementHash: row.raw_requirement_hash,
    signedHeaderHash: row.signed_header_hash,
    signedHeaderValue: row.signed_header_value ?? null,
    txHash: row.tx_hash,
    deployHash: row.deploy_hash,
    intent: row.intent_json,
    hold,
    reconciliationAttempts: attempts,
    auditAnchors: anchors,
  };
}

function rawRequirementHashFromIntent(intent: CasperGuardIntent): string | null {
  return intent.kind === 'x402-payment' ? intent.rawRequirementHash ?? null : null;
}

interface CasperGuardDecisionRow {
  decision_id: string;
  idempotency_key: string;
  org_id: string;
  agent_id: string;
  action_kind: CasperGuardActionKind;
  network: string;
  resource_id: string;
  amount: string;
  asset_kind: 'cep18' | 'native' | 'native-eth' | 'erc20';
  asset_ref: string;
  destination: string | null;
  status: CasperGuardDecisionStatus;
  outcome: 'ALLOW' | 'DENY';
  reason_code: string | null;
  policy_ref: string;
  signer_kind: string | null;
  raw_requirement_hash: string | null;
  signed_header_hash: string | null;
  signed_header_value: string | null;
  tx_hash: string | null;
  deploy_hash: string | null;
  intent_json: CasperGuardIntent;
}

async function readHold(
  pool: pg.Pool,
  decisionId: string,
): Promise<CasperGuardHoldRecord | null> {
  const result = await pool.query<{
    hold_id: string;
    amount: string;
    asset_kind: 'cep18' | 'native' | 'native-eth' | 'erc20';
    asset_ref: string;
    status: 'RESERVED' | 'SETTLED' | 'RELEASED';
    network: string;
  }>(
    `SELECT hold_id, amount::text, asset_kind, asset_ref, status, network
       FROM casper_guard_holds
      WHERE decision_id = $1`,
    [decisionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    holdId: row.hold_id,
    amount: row.amount,
    assetKind: row.asset_kind,
    assetRef: row.asset_ref,
    status: row.status,
    network: row.network,
  };
}

async function readReconciliationAttempts(
  pool: pg.Pool,
  decisionId: string,
): Promise<CasperGuardReconciliationAttemptRecord[]> {
  const result = await pool.query<{
    attempt_number: number;
    source: string;
    status: string;
    evidence: Record<string, unknown>;
    error_code: string | null;
  }>(
    `SELECT attempt_number, source, status, evidence, error_code
       FROM casper_guard_reconciliation_attempts
      WHERE decision_id = $1
      ORDER BY attempt_number ASC`,
    [decisionId],
  );
  return result.rows.map((row) => ({
    attemptNumber: row.attempt_number,
    source: row.source,
    status: row.status,
    evidence: row.evidence,
    errorCode: row.error_code,
  }));
}

async function readAuditAnchors(
  pool: pg.Pool,
  decisionId: string,
): Promise<CasperGuardAuditAnchorRecord[]> {
  const result = await pool.query<{
    anchor_id: string;
    anchor_kind: string;
    decision_hash: string;
    status: string;
    tx_hash: string | null;
  }>(
    `SELECT anchor_id, anchor_kind, decision_hash, status, tx_hash
       FROM casper_guard_audit_anchors
      WHERE decision_id = $1
      ORDER BY anchored_at ASC, anchor_id ASC`,
    [decisionId],
  );
  return result.rows.map((row) => ({
    anchorId: row.anchor_id,
    anchorKind: row.anchor_kind,
    decisionHash: row.decision_hash,
    status: row.status,
    txHash: row.tx_hash,
  }));
}
