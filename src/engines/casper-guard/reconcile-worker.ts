import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { settleHold } from '../ledger/window.js';
import { newCasperGuardAnchorId } from '../../lib/ids.js';
import { resolveCasperGuardTerminalFailure } from './policy.js';
import { emitDecisionSafe } from '../monitoring/telemetry.js';
import type { CasperGuardActionKind } from './types.js';
import {
  appendCasperGuardReconciliationAttempt,
  claimCasperGuardAuditAnchor,
  confirmCasperGuardAuditAnchor,
  failCasperGuardAuditAnchor,
  markCasperGuardDecisionExpiryCheck,
  markCasperGuardDecisionSettled,
  readCasperGuardDecision,
  settleCasperGuardHold,
  type CasperGuardDecisionRecord,
} from './store.js';
import type { CasperGuardDecisionStatus } from './types.js';

type SettlementSource = 'facilitator' | 'casper-rpc' | 'cspr-cloud' | 'operator-wallet';

export type CasperGuardSettlementRead =
  | {
      status: 'settled';
      source: SettlementSource;
      evidence: Record<string, unknown>;
      txHash?: string | null;
      deployHash?: string | null;
    }
  | {
      status: 'pending' | 'ambiguous';
      source: SettlementSource;
      evidence: Record<string, unknown>;
      errorCode?: string | null;
    }
  | {
      status: 'failed' | 'expired';
      source: SettlementSource;
      evidence: Record<string, unknown>;
      errorCode?: string | null;
    };

export interface CasperGuardSettlementReader {
  read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead>;
}

export interface GuardRegistryAnchorer {
  anchorDecision(input: {
    decisionId: string;
    decisionHash: string;
    decision: CasperGuardDecisionRecord;
  }): Promise<{ txHash: string }>;
}

export interface CasperGuardReconcileDeps {
  pool: pg.Pool;
  redis: Redis;
  settlementReader: CasperGuardSettlementReader;
  anchorer?: GuardRegistryAnchorer;
  staleSubmittedAnchorMs?: number;
}

/**
 * Why a settled decision does or does not carry an on-chain proof. A bare `anchored: false` conflates
 * three very different states — the anchorer was never configured, an anchor attempt failed, or the
 * decision was already anchored by an earlier reconcile — and leaves the caller no way to tell which.
 * Each settlement now reports the specific reason so an unanchored decision is diagnosable.
 */
export type AnchorStatus =
  | 'anchored'
  | 'already_anchored'
  | 'not_configured'
  | 'failed'
  | 'skipped_not_settled';

export interface AnchorOutcome {
  anchored: boolean;
  status: AnchorStatus;
  error?: string;
}

export interface CasperGuardReconcileResult {
  decisionId: string;
  status: CasperGuardDecisionStatus;
  settled: boolean;
  anchored: boolean;
  anchorStatus: AnchorStatus;
  anchorError?: string;
}

export async function reconcileCasperGuardDecision(
  deps: CasperGuardReconcileDeps,
  params: { decisionId: string; agentId: string },
): Promise<CasperGuardReconcileResult> {
  const decision = await readCasperGuardDecision(deps.pool, params.decisionId);
  if (!decision) throw new Error('casper_guard_decision_not_found');
  if (decision.agentId !== params.agentId) throw new Error('casper_guard_decision_agent_mismatch');

  if (decision.status === 'SETTLED') {
    const settled = await repairSettledHoldCleanup(deps, decision);
    const anchor = await ensureAuditAnchor(deps, decision);
    return {
      decisionId: decision.decisionId,
      status: 'SETTLED',
      settled,
      anchored: anchor.anchored,
      anchorStatus: anchor.status,
      ...(anchor.error ? { anchorError: anchor.error } : {}),
    };
  }
  if (decision.status === 'EXPIRED' || decision.status === 'FAILED_TERMINAL' || decision.status === 'DENIED') {
    return {
      decisionId: decision.decisionId,
      status: decision.status,
      settled: false,
      anchored: false,
      anchorStatus: 'skipped_not_settled',
    };
  }
  if (decision.outcome !== 'ALLOW' || !decision.signedHeaderHash) {
    throw new Error('casper_guard_decision_not_reconcilable');
  }

  let observed: CasperGuardSettlementRead;
  try {
    observed = await deps.settlementReader.read(decision);
    console.log('[reconcile] settlementReader result:', JSON.stringify({ decisionId: decision.decisionId, status: observed.status, source: observed.source, evidence: observed.evidence }));
  } catch (err) {
    console.error('[reconcile] settlementReader.read THREW:', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
    throw err;
  }
  await appendReconciliationAttempt(deps.pool, {
    decisionId: decision.decisionId,
    attemptNumber: nextAttemptNumber(decision),
    source: observed.source,
    status: attemptStatus(observed.status),
    evidence: observed.evidence,
    errorCode: observed.status === 'settled' ? null : observed.errorCode ?? null,
    network: decision.network,
  });

  console.log('[reconcile] switching on observed.status:', observed.status);
  switch (observed.status) {
    case 'settled': {
      // NOTE: settlement is deliberately NOT gated on the anchorer being configured. The payment has
      // already cleared on-chain at this point; refusing to record that because audit anchoring is
      // unconfigured would strand a real settled payment in an unsettled state. Anchoring is an
      // additive audit proof — its absence is reported via anchorStatus, never by failing settlement.
      const settled = await settleSignedDecision(deps, decision, observed);
      const refreshed = await readCasperGuardDecision(deps.pool, decision.decisionId);
      if (!refreshed) throw new Error('casper_guard_decision_not_found_after_settle');
      if (refreshed.status !== 'SETTLED') {
        return resultFromCurrentDecision(deps, refreshed);
      }
      const anchor = await ensureAuditAnchor(deps, refreshed);
      return {
        decisionId: decision.decisionId,
        status: 'SETTLED',
        settled,
        anchored: anchor.anchored,
        anchorStatus: anchor.status,
        ...(anchor.error ? { anchorError: anchor.error } : {}),
      };
    }
    case 'ambiguous':
    case 'pending': {
      await markCasperGuardDecisionExpiryCheck(deps.pool, decision.decisionId);
      const refreshed = await readCasperGuardDecision(deps.pool, decision.decisionId);
      if (!refreshed) throw new Error('casper_guard_decision_not_found_after_expiry_check');
      return resultFromCurrentDecision(deps, refreshed);
    }
    case 'expired': {
      await resolveCasperGuardTerminalFailure(deps, {
        decisionId: decision.decisionId,
        agentId: params.agentId,
        status: 'EXPIRED',
      });
      const refreshed = await readCasperGuardDecision(deps.pool, decision.decisionId);
      if (!refreshed) throw new Error('casper_guard_decision_not_found_after_expire');
      void emitDecisionSafe(deps.redis, {
        paymentId: decision.decisionId,
        agentId: decision.agentId,
        orgId: decision.orgId,
        outcome: 'EXPIRED',
        ...(refreshed.hold?.status ? { holdStatus: refreshed.hold.status } : {}),
        railScheme: railForAction(decision.actionKind),
        railChain: decision.network,
        resourceId: decision.resourceId,
        amount: decision.amount,
        ts: Date.now(),
      });
      return resultFromCurrentDecision(deps, refreshed);
    }
    case 'failed': {
      await resolveCasperGuardTerminalFailure(deps, {
        decisionId: decision.decisionId,
        agentId: params.agentId,
        status: 'FAILED_TERMINAL',
      });
      const refreshed = await readCasperGuardDecision(deps.pool, decision.decisionId);
      if (!refreshed) throw new Error('casper_guard_decision_not_found_after_fail');
      void emitDecisionSafe(deps.redis, {
        paymentId: decision.decisionId,
        agentId: decision.agentId,
        orgId: decision.orgId,
        outcome: 'FAILED_TERMINAL',
        ...(refreshed.hold?.status ? { holdStatus: refreshed.hold.status } : {}),
        railScheme: railForAction(decision.actionKind),
        railChain: decision.network,
        resourceId: decision.resourceId,
        amount: decision.amount,
        ts: Date.now(),
      });
      return resultFromCurrentDecision(deps, refreshed);
    }
  }
}

async function appendReconciliationAttempt(
  pool: pg.Pool,
  input: Parameters<typeof appendCasperGuardReconciliationAttempt>[1],
): Promise<void> {
  let attemptNumber = input.attemptNumber;
  for (let retry = 0; retry < 5; retry += 1) {
    try {
      await appendCasperGuardReconciliationAttempt(pool, { ...input, attemptNumber });
      return;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const current = await readCasperGuardDecision(pool, input.decisionId);
      if (!current) throw err;
      attemptNumber = nextAttemptNumber(current);
    }
  }
  throw new Error('casper_guard_reconciliation_attempt_conflict');
}

function nextAttemptNumber(decision: CasperGuardDecisionRecord): number {
  return Math.max(0, ...decision.reconciliationAttempts.map((attempt) => attempt.attemptNumber)) + 1;
}

function attemptStatus(status: CasperGuardSettlementRead['status']): 'pending' | 'settled' | 'failed' | 'ambiguous' {
  if (status === 'expired') return 'failed';
  return status;
}

async function settleSignedDecision(
  deps: CasperGuardReconcileDeps,
  decision: CasperGuardDecisionRecord,
  observed: Extract<CasperGuardSettlementRead, { status: 'settled' }>,
): Promise<boolean> {
  const decisionSettled = await markCasperGuardDecisionSettled(deps.pool, {
    decisionId: decision.decisionId,
    txHash: observed.txHash ?? null,
    deployHash: observed.deployHash ?? null,
  });
  if (!decisionSettled) return false;
  await Promise.all([
    settleHold(deps.redis, decision.agentId, decision.decisionId),
    settleCasperGuardHold(deps.pool, decision.decisionId),
  ]);
  const txHash = observed.txHash ?? observed.deployHash ?? undefined;
  void emitDecisionSafe(deps.redis, {
    paymentId: decision.decisionId,
    agentId: decision.agentId,
    orgId: decision.orgId,
    outcome: 'SETTLED',
    holdStatus: 'SETTLED',
    ...(txHash ? { txHash } : {}),
    railScheme: railForAction(decision.actionKind),
    railChain: decision.network,
    resourceId: decision.resourceId,
    amount: decision.amount,
    ts: Date.now(),
  });
  return true;
}

async function repairSettledHoldCleanup(
  deps: CasperGuardReconcileDeps,
  decision: CasperGuardDecisionRecord,
): Promise<boolean> {
  const [redisSettled, holdSettled] = await Promise.all([
    settleHold(deps.redis, decision.agentId, decision.decisionId),
    settleCasperGuardHold(deps.pool, decision.decisionId),
  ]);
  return redisSettled || holdSettled;
}

async function ensureAuditAnchor(
  deps: CasperGuardReconcileDeps,
  decision: CasperGuardDecisionRecord,
): Promise<AnchorOutcome> {
  const decisionHash = computeCasperGuardDecisionHash(decision);
  const existing = decision.auditAnchors.find(
    (anchor) =>
      anchor.anchorKind === 'odra-guard-registry' &&
      anchor.decisionHash === decisionHash &&
      anchor.status === 'confirmed',
  );
  // Already on-chain from an earlier reconcile. This is a SUCCESS — the proof exists — even though
  // this particular call did not submit it, so it must not read as "unanchored".
  if (existing) return { anchored: true, status: 'already_anchored' };

  // Anchoring unconfigured is a deployment state, not an error: settlement already succeeded and the
  // decision is durable in Postgres. Report it precisely instead of throwing, so the caller can tell
  // "no Odra contract bound" apart from "the anchor attempt failed".
  if (!deps.anchorer) return { anchored: false, status: 'not_configured' };

  const anchorId = await claimCasperGuardAuditAnchor(deps.pool, {
      anchorId: newCasperGuardAnchorId(),
      decisionId: decision.decisionId,
      decisionHash,
      staleSubmittedMs: deps.staleSubmittedAnchorMs ?? 300_000,
      network: decision.network,
    });
  // Another worker holds the claim and is mid-submit; not a failure of this call.
  if (!anchorId) return { anchored: false, status: 'already_anchored' };

  try {
    const anchored = await deps.anchorer.anchorDecision({
      decisionId: decision.decisionId,
      decisionHash,
      decision,
    });
    const confirmed = await confirmCasperGuardAuditAnchor(deps.pool, { anchorId, txHash: anchored.txHash });
    return confirmed
      ? { anchored: true, status: 'anchored' }
      : { anchored: false, status: 'failed', error: 'anchor_confirm_write_failed' };
  } catch (err) {
    await failCasperGuardAuditAnchor(deps.pool, anchorId);
    // Anchoring failure is non-fatal — settlement already succeeded — but the REASON is surfaced to
    // the caller rather than being reduced to a bare false.
    const error = err instanceof Error ? err.message : String(err);
    console.error('casper_guard_anchor_failed', { decisionId: decision.decisionId, error });
    return { anchored: false, status: 'failed', error };
  }
}

async function resultFromCurrentDecision(
  deps: CasperGuardReconcileDeps,
  decision: CasperGuardDecisionRecord,
): Promise<CasperGuardReconcileResult> {
  if (decision.status === 'SETTLED') {
    const settled = await repairSettledHoldCleanup(deps, decision);
    const anchor = await ensureAuditAnchor(deps, decision);
    return {
      decisionId: decision.decisionId,
      status: 'SETTLED',
      settled,
      anchored: anchor.anchored,
      anchorStatus: anchor.status,
      ...(anchor.error ? { anchorError: anchor.error } : {}),
    };
  }
  return {
    decisionId: decision.decisionId,
    status: decision.status,
    settled: false,
    anchored: false,
    anchorStatus: 'skipped_not_settled',
  };
}

export function computeCasperGuardDecisionHash(decision: CasperGuardDecisionRecord): string {
  const canonical = stableJson({
    decisionId: decision.decisionId,
    orgId: decision.orgId,
    agentId: decision.agentId,
    actionKind: decision.actionKind,
    network: decision.network,
    resourceId: decision.resourceId,
    amount: decision.amount,
    assetKind: decision.assetKind,
    assetRef: decision.assetRef,
    destination: decision.destination,
    outcome: decision.outcome,
    policyRef: decision.policyRef,
    signedHeaderHash: decision.signedHeaderHash,
    txHash: decision.txHash,
    deployHash: decision.deployHash,
    intent: decision.intent,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stabilize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stabilize(item)]),
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505';
}

function railForAction(action: CasperGuardActionKind): string {
  switch (action) {
    case 'x402-payment': return 'casper-x402';
    case 'cspr-trade': return 'cspr-trade';
    case 'casper-deploy': return 'casper-deploy';
    case 'evm-transfer': return 'evm-transfer';
  }
}
