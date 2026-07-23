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

export interface CasperGuardReconcileResult {
  decisionId: string;
  status: CasperGuardDecisionStatus;
  settled: boolean;
  anchored: boolean;
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
    const anchored = await ensureAuditAnchor(deps, decision);
    return { decisionId: decision.decisionId, status: 'SETTLED', settled, anchored };
  }
  if (decision.status === 'EXPIRED' || decision.status === 'FAILED_TERMINAL' || decision.status === 'DENIED') {
    return { decisionId: decision.decisionId, status: decision.status, settled: false, anchored: false };
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
      console.log('[reconcile] settled — checking anchorer, deps.anchorer:', !!deps.anchorer);
      ensureAnchorerConfigured(deps);
      const settled = await settleSignedDecision(deps, decision, observed);
      const refreshed = await readCasperGuardDecision(deps.pool, decision.decisionId);
      if (!refreshed) throw new Error('casper_guard_decision_not_found_after_settle');
      if (refreshed.status !== 'SETTLED') {
        return resultFromCurrentDecision(deps, refreshed);
      }
      const anchored = await ensureAuditAnchor(deps, refreshed);
      return { decisionId: decision.decisionId, status: 'SETTLED', settled, anchored };
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
): Promise<boolean> {
  const decisionHash = computeCasperGuardDecisionHash(decision);
  const existing = decision.auditAnchors.find(
    (anchor) =>
      anchor.anchorKind === 'odra-guard-registry' &&
      anchor.decisionHash === decisionHash &&
      anchor.status === 'confirmed',
  );
  if (existing) return false;

  ensureAnchorerConfigured(deps);
  const anchorId = await claimCasperGuardAuditAnchor(deps.pool, {
      anchorId: newCasperGuardAnchorId(),
      decisionId: decision.decisionId,
      decisionHash,
      staleSubmittedMs: deps.staleSubmittedAnchorMs ?? 300_000,
      network: decision.network,
    });
  if (!anchorId) return false;

  try {
    const anchored = await deps.anchorer.anchorDecision({
      decisionId: decision.decisionId,
      decisionHash,
      decision,
    });
    return await confirmCasperGuardAuditAnchor(deps.pool, { anchorId, txHash: anchored.txHash });
  } catch (err) {
    await failCasperGuardAuditAnchor(deps.pool, anchorId);
    // Anchoring failure is non-fatal — settlement already succeeded. Log and return false.
    console.error('casper_guard_anchor_failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function resultFromCurrentDecision(
  deps: CasperGuardReconcileDeps,
  decision: CasperGuardDecisionRecord,
): Promise<CasperGuardReconcileResult> {
  if (decision.status === 'SETTLED') {
    const settled = await repairSettledHoldCleanup(deps, decision);
    const anchored = await ensureAuditAnchor(deps, decision);
    return { decisionId: decision.decisionId, status: 'SETTLED', settled, anchored };
  }
  return {
    decisionId: decision.decisionId,
    status: decision.status,
    settled: false,
    anchored: false,
  };
}

function ensureAnchorerConfigured(
  deps: CasperGuardReconcileDeps,
): asserts deps is CasperGuardReconcileDeps & { anchorer: GuardRegistryAnchorer } {
  if (!deps.anchorer) throw new Error('casper_guard_anchorer_unconfigured');
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
