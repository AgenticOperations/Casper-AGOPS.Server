import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { releaseHold, reserveHoldWithinPolicy, windowSum, snapshotWindows } from '../ledger/window.js';
import { keys } from '../../redis/keyspace.js';
import type {
  CasperGuardActionKind,
  CasperGuardIntent,
  CasperGuardNetwork,
} from './types.js';
import {
  createCasperGuardDecision,
  createCasperGuardDecisionAndHold,
  markCasperGuardDecisionSigned,
  markCasperGuardDecisionTerminal,
  readCasperGuardDecision,
  readCasperGuardDecisionByIdempotency,
  releaseCasperGuardHold,
  type CasperGuardDecisionRecord,
} from './store.js';
import { casperGuardAssetRef, casperGuardIntentPrimaryAsset } from './types.js';

export type CasperGuardDenyReason =
  | 'per_transaction_max_exceeded'
  | 'spend_cap_exceeded'
  | 'action_not_allowed'
  | 'network_not_allowed'
  | 'service_not_allowed'
  | 'service_scope_destination_mismatch'
  | 'velocity_exceeded'
  | 'org_suspended'
  | 'trade_risk_exceeded'
  | 'idempotency_in_progress'
  | 'idempotency_conflict'
  | 'x402_asset_not_supported'
  | 'action_kind_resource_mismatch'
  | 'legal_acceptance_required'
  | 'legal_context_fetch_failed'
  | 'legal_terms_hash_mismatch';

export interface CasperGuardPolicy {
  policyRef: string;
  spendCap: string;
  perTransactionMax: string;
  serviceScope: string[];
  /**
   * Authoritative (resourceId → payTo) bindings registered by the operator.
   * When an entry exists for the intent's resourceId, the intent's destination
   * (payTo from accepts[0]) MUST exactly match the registered address.
   * An agent cannot substitute an in-scope resourceId to obtain authorization
   * for a different payTo recipient — the destination is enforced at the policy
   * layer, independent of what the agent claims in payment_required.resource.url.
   */
  serviceDestinations?: Record<string, string>;
  allowedActions: CasperGuardActionKind[];
  allowedNetworks: CasperGuardNetwork[];
  velocityLimitPerHour: number;
  trade?: {
    maxSlippageBps: number;
    allowedRiskLabels: string[];
  };
  lcp?: {
    required: boolean;
    minTrustLevel: 1 | 2 | 3 | 4;
    failOpen: boolean;
  };
}

export interface CasperGuardSigner {
  kind: string;
  sign(input: {
    decisionId: string;
    intent: CasperGuardIntent;
  }): Promise<{
    signedHeaderHash: string;
    headers?: Record<string, string>;
    txHash?: string | null;
    deployHash?: string | null;
  }>;
}

export interface CasperGuardPolicyDeps {
  pool: pg.Pool;
  redis: Redis;
  signer: CasperGuardSigner;
}

export interface CasperGuardReleaseDeps {
  pool: pg.Pool;
  redis: Redis;
}

export type CasperGuardAuthorizeResult =
  | {
      outcome: 'ALLOW';
      decisionId: string;
      holdId: string;
      signedHeaderHash: string;
      headers?: Record<string, string>;
      txHash?: string | null;
      deployHash?: string | null;
    }
  | { outcome: 'DENY'; decisionId: string; reason: CasperGuardDenyReason; detail?: string };

export async function authorizeCasperGuardIntent(
  deps: CasperGuardPolicyDeps,
  params: {
    decisionId: string;
    holdId: string;
    idempotencyKey: string;
    orgId: string;
    agentId: string;
    intent: CasperGuardIntent;
    policy: CasperGuardPolicy;
    now: number;
  },
): Promise<CasperGuardAuthorizeResult> {
  const requestFingerprint = idempotencyFingerprint(params);
  const lock = await acquireIdempotencyLock(
    deps.redis,
    params.orgId,
    params.idempotencyKey,
    params.decisionId,
    requestFingerprint,
  );
  if (!lock.acquired) {
    const existing = await readCasperGuardDecisionByIdempotency(deps.pool, {
      orgId: params.orgId,
      idempotencyKey: params.idempotencyKey,
    });
    if (existing) return authorizeResultFromExisting(existing, params);
    const locked = await readIdempotencyLock(deps.redis, lock.key);
    if (locked?.fingerprint && locked.fingerprint !== requestFingerprint) {
      return { outcome: 'DENY', decisionId: params.decisionId, reason: 'idempotency_conflict' };
    }
    return { outcome: 'DENY', decisionId: params.decisionId, reason: 'idempotency_in_progress' };
  }

  try {
    const existing = await readCasperGuardDecisionByIdempotency(deps.pool, {
      orgId: params.orgId,
      idempotencyKey: params.idempotencyKey,
    });
    if (existing) return authorizeResultFromExisting(existing, params);

    const decision = await evaluateCasperGuardPolicy(deps.redis, params);
    if (!decision.allow) {
      await persistDeny(deps.pool, params, decision.reason);
      return { outcome: 'DENY', decisionId: params.decisionId, reason: decision.reason };
    }

    const reserve = await reserveHoldWithinPolicy(deps.redis, {
      agentId: params.agentId,
      paymentId: params.decisionId,
      amount: BigInt(params.intent.amount),
      enforcementTs: params.now,
      spendCap: BigInt(params.policy.spendCap),
      velocityLimitPerHour: params.policy.velocityLimitPerHour,
    });
    if (reserve === 'cap_exceeded' || reserve === 'velocity_exceeded') {
      const reason = reserve === 'cap_exceeded' ? 'spend_cap_exceeded' : 'velocity_exceeded';
      await persistDeny(deps.pool, params, reason);
      const detail = await buildDenyDetail(deps.redis, params, reason);
      return { outcome: 'DENY', decisionId: params.decisionId, reason, ...(detail ? { detail } : {}) };
    }
    if (reserve === 'duplicate') {
      return {
        outcome: 'DENY',
        decisionId: params.decisionId,
        reason: 'idempotency_in_progress',
      };
    }

    const asset = casperGuardIntentPrimaryAsset(params.intent);
    try {
      await createCasperGuardDecisionAndHold(
        deps.pool,
        {
          decisionId: params.decisionId,
          idempotencyKey: params.idempotencyKey,
          orgId: params.orgId,
          agentId: params.agentId,
          intent: params.intent,
          status: 'RESERVED',
          outcome: 'ALLOW',
          policyRef: params.policy.policyRef,
          signerKind: deps.signer.kind,
        },
        {
          holdId: params.holdId,
          decisionId: params.decisionId,
          orgId: params.orgId,
          agentId: params.agentId,
          amount: params.intent.amount,
          assetKind: asset.kind,
          assetRef: casperGuardAssetRef(asset),
          status: 'RESERVED',
          network: params.intent.network,
        },
      );
    } catch (err) {
      await releaseHold(deps.redis, params.agentId, params.decisionId);
      if (isUniqueViolation(err)) {
        const replayed = await readCasperGuardDecisionByIdempotency(deps.pool, {
          orgId: params.orgId,
          idempotencyKey: params.idempotencyKey,
        });
        if (replayed) return authorizeResultFromExisting(replayed, params);
      }
      throw err;
    }

    try {
      if ((await deps.redis.exists(keys.denyAll(params.orgId))) === 1) {
        await failReservedDecision(deps, params);
        return { outcome: 'DENY', decisionId: params.decisionId, reason: 'org_suspended' };
      }

      const signed = await deps.signer.sign({
        decisionId: params.decisionId,
        intent: params.intent,
      });
      const signedMarked = await markCasperGuardDecisionSigned(deps.pool, {
        decisionId: params.decisionId,
        signedHeaderHash: signed.signedHeaderHash,
        signedHeaderValue: signed.headers?.['PAYMENT-SIGNATURE'] ?? null,
        txHash: signed.txHash ?? null,
        deployHash: signed.deployHash ?? null,
      });
      if (!signedMarked) {
        throw new Error('casper_guard_invalid_sign_transition');
      }
      return {
        outcome: 'ALLOW',
        decisionId: params.decisionId,
        holdId: params.holdId,
        signedHeaderHash: signed.signedHeaderHash,
        ...(signed.headers ? { headers: signed.headers } : {}),
        ...(signed.txHash !== undefined ? { txHash: signed.txHash ?? null } : {}),
        ...(signed.deployHash !== undefined ? { deployHash: signed.deployHash ?? null } : {}),
      };
    } catch (err) {
      await failReservedDecision(deps, params);
      throw err;
    }
  } finally {
    await releaseIdempotencyLock(deps.redis, lock.key, params.decisionId);
  }
}

export async function resolveCasperGuardTerminalFailure(
  deps: CasperGuardReleaseDeps,
  params: {
    decisionId: string;
    agentId: string;
    status: 'FAILED_TERMINAL' | 'EXPIRED';
  },
): Promise<{ decisionId: string; released: boolean }> {
  const existing = await readCasperGuardDecision(deps.pool, params.decisionId);
  if (!existing || existing.status === 'DENIED' || existing.status === 'SETTLED') {
    return { decisionId: params.decisionId, released: false };
  }
  if (existing.status !== 'FAILED_TERMINAL' && existing.status !== 'EXPIRED') {
    const transitioned = await markCasperGuardDecisionTerminal(deps.pool, {
      decisionId: params.decisionId,
      status: params.status,
    });
    if (!transitioned) return { decisionId: params.decisionId, released: false };
  }
  const [redisReleased, dbReleased] = await Promise.all([
    releaseHold(deps.redis, params.agentId, params.decisionId),
    releaseCasperGuardHold(deps.pool, params.decisionId),
  ]);
  return { decisionId: params.decisionId, released: redisReleased || dbReleased };
}

async function evaluateCasperGuardPolicy(
  redis: Redis,
  params: {
    agentId: string;
    orgId: string;
    intent: CasperGuardIntent;
    policy: CasperGuardPolicy;
    now: number;
  },
): Promise<{ allow: true } | { allow: false; reason: CasperGuardDenyReason }> {
  if ((await redis.exists(keys.denyAll(params.orgId))) === 1) {
    return { allow: false, reason: 'org_suspended' };
  }
  if (!params.policy.allowedActions.includes(params.intent.kind)) {
    return { allow: false, reason: 'action_not_allowed' };
  }
  if (!params.policy.allowedNetworks.includes(params.intent.network)) {
    return { allow: false, reason: 'network_not_allowed' };
  }
  if (!params.policy.serviceScope.includes(params.intent.resourceId)) {
    return { allow: false, reason: 'service_not_allowed' };
  }

  // Prevent action_kind/resource_id mismatches that would always dead-end at the settlement layer.
  // svc:* resource IDs are x402 HTTP services — they must use x402-payment, never casper-deploy.
  // cspr.trade:* resource IDs are DEX swap routes — they must use cspr-trade, never casper-deploy.
  // A casper-deploy to these resources produces an EXPIRY_CHECK loop with no deploy ever submitted.
  if (params.intent.kind === 'casper-deploy') {
    const r = params.intent.resourceId;
    if (r.startsWith('svc:') || r.startsWith('cspr.trade:')) {
      return { allow: false, reason: 'action_kind_resource_mismatch' };
    }
  }

  // Destination binding: when the policy registers an authoritative payTo for this resourceId,
  // the intent's destination MUST match. This closes the policy-bypass where an agent supplies
  // an in-scope resourceId in payment_required.resource.url while routing the payment to an
  // out-of-scope service's payTo address.
  if (params.intent.kind === 'x402-payment') {
    const registeredDestination = params.policy.serviceDestinations?.[params.intent.resourceId];
    if (
      registeredDestination !== undefined &&
      registeredDestination.trim().toLowerCase() !== params.intent.destination.trim().toLowerCase()
    ) {
      return { allow: false, reason: 'service_scope_destination_mismatch' };
    }
  }

  if (params.intent.kind === 'x402-payment' && params.intent.asset.kind !== 'cep18') {
    return { allow: false, reason: 'x402_asset_not_supported' };
  }

  const amount = BigInt(params.intent.amount);
  const perTransactionMax = BigInt(params.policy.perTransactionMax);
  if (amount > perTransactionMax) {
    return { allow: false, reason: 'per_transaction_max_exceeded' };
  }

  if (params.intent.kind === 'cspr-trade') {
    const tradePolicy = params.policy.trade;
    if (
      !tradePolicy ||
      params.intent.slippageBps > tradePolicy.maxSlippageBps ||
      !params.intent.riskLabel ||
      !tradePolicy.allowedRiskLabels.includes(params.intent.riskLabel)
    ) {
      return { allow: false, reason: 'trade_risk_exceeded' };
    }
  }

  return { allow: true };
}

async function persistDeny(
  pool: pg.Pool,
  params: {
    decisionId: string;
    idempotencyKey: string;
    orgId: string;
    agentId: string;
    intent: CasperGuardIntent;
    policy: CasperGuardPolicy;
  },
  reason: CasperGuardDenyReason,
): Promise<void> {
  try {
    await createCasperGuardDecision(pool, {
      decisionId: params.decisionId,
      idempotencyKey: params.idempotencyKey,
      orgId: params.orgId,
      agentId: params.agentId,
      intent: params.intent,
      status: 'DENIED',
      outcome: 'DENY',
      policyRef: params.policy.policyRef,
      reasonCode: reason,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

function authorizeResultFromExisting(
  record: CasperGuardDecisionRecord,
  params?: {
    decisionId: string;
    agentId: string;
    intent: CasperGuardIntent;
    policy: CasperGuardPolicy;
  },
): CasperGuardAuthorizeResult {
  if (params && !idempotencyReplayMatches(record, params)) {
    return { outcome: 'DENY', decisionId: params.decisionId, reason: 'idempotency_conflict' };
  }
  if (record.outcome === 'DENY') {
    return {
      outcome: 'DENY',
      decisionId: record.decisionId,
      reason: (record.reasonCode ?? 'idempotency_in_progress') as CasperGuardDenyReason,
    };
  }
  if (record.signedHeaderHash && record.hold) {
    return {
      outcome: 'ALLOW',
      decisionId: record.decisionId,
      holdId: record.hold.holdId,
      signedHeaderHash: record.signedHeaderHash,
      ...(record.txHash !== null ? { txHash: record.txHash } : {}),
      ...(record.deployHash !== null ? { deployHash: record.deployHash } : {}),
    };
  }
  return {
    outcome: 'DENY',
    decisionId: record.decisionId,
    reason: 'idempotency_in_progress',
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

async function acquireIdempotencyLock(
  redis: Redis,
  orgId: string,
  idempotencyKey: string,
  decisionId: string,
  fingerprint: string,
): Promise<{ acquired: boolean; key: string }> {
  const key = `casper_guard:idempotency:${orgId}:${sha256(idempotencyKey)}`;
  const acquired = await redis.set(
    key,
    JSON.stringify({ decisionId, fingerprint }),
    'EX',
    30,
    'NX',
  );
  return { acquired: acquired === 'OK', key };
}

async function releaseIdempotencyLock(redis: Redis, key: string, decisionId: string): Promise<void> {
  const current = await redis.get(key);
  if (current === decisionId || parseIdempotencyLock(current)?.decisionId === decisionId) await redis.del(key);
}

async function readIdempotencyLock(
  redis: Redis,
  key: string,
): Promise<{ decisionId: string; fingerprint?: string } | null> {
  return parseIdempotencyLock(await redis.get(key));
}

function parseIdempotencyLock(value: string | null): { decisionId: string; fingerprint?: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { decisionId?: unknown; fingerprint?: unknown };
    if (typeof parsed.decisionId !== 'string') return null;
    return {
      decisionId: parsed.decisionId,
      ...(typeof parsed.fingerprint === 'string' ? { fingerprint: parsed.fingerprint } : {}),
    };
  } catch {
    return { decisionId: value };
  }
}

function idempotencyReplayMatches(
  record: CasperGuardDecisionRecord,
  params: {
    agentId: string;
    intent: CasperGuardIntent;
    policy: CasperGuardPolicy;
  },
): boolean {
  const asset = casperGuardIntentPrimaryAsset(params.intent);
  return (
    record.agentId === params.agentId &&
    record.actionKind === params.intent.kind &&
    record.network === params.intent.network &&
    record.resourceId === params.intent.resourceId &&
    record.amount === params.intent.amount &&
    record.assetKind === asset.kind &&
    record.assetRef === casperGuardAssetRef(asset) &&
    record.policyRef === params.policy.policyRef &&
    stableJson(record.intent) === stableJson(params.intent)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function idempotencyFingerprint(params: {
  agentId: string;
  intent: CasperGuardIntent;
  policy: CasperGuardPolicy;
}): string {
  return sha256(
    stableJson({
      agentId: params.agentId,
      intent: params.intent,
      policyRef: params.policy.policyRef,
    }),
  );
}

async function failReservedDecision(
  deps: CasperGuardPolicyDeps,
  params: { agentId: string; decisionId: string },
): Promise<void> {
  const transitioned = await markCasperGuardDecisionTerminal(deps.pool, {
    decisionId: params.decisionId,
    status: 'FAILED_TERMINAL',
  });
  if (!transitioned) return;
  const results = await Promise.allSettled([
    releaseHold(deps.redis, params.agentId, params.decisionId),
    releaseCasperGuardHold(deps.pool, params.decisionId),
  ]);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}

/** Build a human-readable detail string for spend_cap_exceeded / velocity_exceeded denials. */
async function buildDenyDetail(
  redis: Redis,
  params: { agentId: string; now: number; policy: CasperGuardPolicy; intent: CasperGuardIntent },
  reason: 'spend_cap_exceeded' | 'velocity_exceeded',
): Promise<string | null> {
  try {
    const snapshot = snapshotWindows(params.now);
    if (reason === 'spend_cap_exceeded') {
      const used = await windowSum(redis, params.agentId, '30d', snapshot['30d']);
      const cap = BigInt(params.policy.spendCap);
      const requested = BigInt(params.intent.amount);
      const motesToCspr = (m: bigint) => (Number(m) / 1_000_000_000).toFixed(4);
      return `Spend cap is ${motesToCspr(cap)} CSPR. Already used ${motesToCspr(used)} CSPR in the current 30-day window. Requested ${motesToCspr(requested)} CSPR would exceed the cap by ${motesToCspr(used + requested - cap)} CSPR.`;
    }
    if (reason === 'velocity_exceeded') {
      const usedThisHour = await windowSum(redis, params.agentId, '1h', snapshot['1h']);
      const limit = params.policy.velocityLimitPerHour;
      const motesToCspr = (m: bigint) => (Number(m) / 1_000_000_000).toFixed(4);
      return `Velocity limit is ${limit} payments per hour. ${motesToCspr(usedThisHour)} CSPR already spent this hour — limit reached.`;
    }
    return null;
  } catch {
    return null;
  }
}
