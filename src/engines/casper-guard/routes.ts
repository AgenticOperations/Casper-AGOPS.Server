import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { lcpDiscover } from '../../lib/lcp/discover.js';
import { emitDecisionSafe } from '../monitoring/telemetry.js';
import type { DenyReason } from '../../contracts/index.js';
import { z } from 'zod';
import { composeSettlementReader } from '../../lib/casper/settlement-reader.js';
import {
  CASPER_X402_HEADER_NAME,
  CASPER_X402_TESTNET_NETWORK,
  CASPER_X402_VERSION,
  validateCasperPaymentRequired,
  type CasperX402PaymentRequirements,
} from '../../lib/casper/x402.js';
import { newCasperGuardDecisionId, newCasperGuardHoldId } from '../../lib/ids.js';
import { authForRoute } from '../identity/access/route-guard.js';
import { authenticateAgent } from '../oracle/auth.js';
import { resolveEffectivePolicy } from '../enforcement/policy-epoch-guard.js';
import {
  authorizeCasperGuardIntent,
  type CasperGuardPolicy,
  type CasperGuardSigner,
} from './policy.js';
import {
  reconcileCasperGuardDecision,
  type CasperGuardSettlementRead,
  type CasperGuardSettlementReader,
  type GuardRegistryAnchorer,
} from './reconcile-worker.js';
import { readCasperGuardDecision, type CasperGuardDecisionRecord } from './store.js';
import {
  normalizeCasperGuardIntent,
  type CasperGuardActionKind,
  type CasperGuardIntent,
  type CasperGuardNetwork,
} from './types.js';
import {
  CASPER_NETWORK_HEADER,
  resolveRequestNetwork,
  type CasperScopedNetwork,
} from './network-header.js';

export interface CasperGuardReadiness {
  configured: boolean;
  reason?: string;
}

export interface CasperGuardNetworkSlot {
  signer?: CasperGuardSigner;
  liveSettlement?: CasperGuardReadiness;
  settlementReaderFactory?: () => CasperGuardSettlementReader;
  odra?: CasperGuardReadiness & { contractPackage?: string };
  anchorer?: GuardRegistryAnchorer;
  tradeExecutor?: {
    available: boolean;
    execute(input: { intent: { pair: string; amount: string } }): Promise<unknown>;
  };
}

export interface CasperGuardDeps {
  // shared
  networks?: CasperGuardNetwork[];
  mcpUrl?: string;
  trade?: {
    maxSlippageBps: number;
    allowedRiskLabels: string[];
  };
  /**
   * Authoritative (resourceId → payTo) bindings for x402-payment scope enforcement.
   * When a resourceId is present in this map, authorize_payment rejects any intent whose
   * destination (payTo from accepts[0]) does not exactly match the registered address.
   * This closes the policy-bypass where an agent substitutes an in-scope resource.url
   * to obtain a signature for an out-of-scope payTo recipient.
   */
  serviceDestinations?: Record<string, string>;
  // per-network
  byNetwork?: Partial<Record<'casper:casper-test' | 'casper:casper', CasperGuardNetworkSlot>>;
  // legacy top-level (testnet mirror) — kept until all route call sites migrate to byNetwork
  signer?: CasperGuardSigner;
  liveSettlement?: CasperGuardReadiness;
  settlementReaderFactory?: () => CasperGuardSettlementReader;
  odra?: CasperGuardReadiness & { contractPackage?: string };
  anchorer?: GuardRegistryAnchorer;
  tradeExecutor?: {
    available: boolean;
    execute(input: { intent: { pair: string; amount: string } }): Promise<unknown>;
  };
}

const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/);
const idempotencyKeySchema = z.string().trim().min(8).max(160);

const x402RequirementSchema = z
  .object({
    scheme: z.literal('exact'),
    network: z.enum(['casper:casper-test', 'casper:casper']),
    amount: positiveIntegerString,
    asset: z.string().regex(/^[0-9a-fA-F]{64}$/),
    payTo: z.string().regex(/^00[0-9a-fA-F]{64}$/),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.object({
      name: z.string().trim().min(1),
      version: z.string().trim().min(1),
    }),
  })
  .passthrough();

const paymentRequiredSchema = z
  .object({
    x402Version: z.literal(CASPER_X402_VERSION),
    resource: z
      .object({
        url: z.string().trim().min(1).optional(),
        serviceName: z.string().trim().min(1).optional(),
      })
      .optional(),
    accepts: z.array(x402RequirementSchema).min(1),
  })
  .passthrough();

const authorizeX402Schema = z.object({
  agent_id: z.string().min(1),
  idempotency_key: idempotencyKeySchema,
  payment_required: paymentRequiredSchema,
});

const authorizeActionSchema = z.object({
  agent_id: z.string().min(1),
  idempotency_key: idempotencyKeySchema,
  intent: z.unknown(),
});

const settlementSourceSchema = z.enum(['facilitator', 'casper-rpc', 'cspr-cloud', 'operator-wallet']);
const settlementEvidenceSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('settled'),
    source: settlementSourceSchema,
    evidence: z.record(z.unknown()).default({}),
    tx_hash: z.string().trim().min(1).optional(),
    deploy_hash: z.string().trim().min(1).optional(),
  }),
  z.object({
    status: z.enum(['pending', 'ambiguous']),
    source: settlementSourceSchema,
    evidence: z.record(z.unknown()).default({}),
    error_code: z.string().trim().min(1).optional(),
  }),
  z.object({
    status: z.enum(['failed', 'expired']),
    source: settlementSourceSchema,
    evidence: z.record(z.unknown()).default({}),
    error_code: z.string().trim().min(1).optional(),
  }),
]);

const reconcileRequestSchema = z.object({
  agent_id: z.string().min(1),
  settlement: settlementEvidenceSchema,
});

type NetworkSlotSelection =
  | { ok: true; network: CasperScopedNetwork; slot: CasperGuardNetworkSlot }
  | { ok: false; code: 400 | 503; error: 'invalid_network' | 'network_not_configured' };

/**
 * Resolve the request's network header, then select its config slot. Falls back to the legacy
 * top-level deps fields for testnet when byNetwork is absent — this is what keeps every existing
 * caller (and test) that never populated byNetwork working unchanged.
 */
export function selectNetworkSlot(
  deps: CasperGuardDeps | undefined,
  headerValue: string | string[] | undefined,
): NetworkSlotSelection {
  const resolved = resolveRequestNetwork(headerValue);
  if (!resolved.ok) return { ok: false, code: 400, error: 'invalid_network' };

  const slot = deps?.byNetwork?.[resolved.network];
  if (slot?.signer) return { ok: true, network: resolved.network, slot };

  if (resolved.network === 'casper:casper-test' && !deps?.byNetwork && deps?.signer) {
    return {
      ok: true,
      network: resolved.network,
      slot: {
        signer: deps.signer,
        ...(deps.liveSettlement ? { liveSettlement: deps.liveSettlement } : {}),
        ...(deps.settlementReaderFactory ? { settlementReaderFactory: deps.settlementReaderFactory } : {}),
        ...(deps.odra ? { odra: deps.odra } : {}),
        ...(deps.anchorer ? { anchorer: deps.anchorer } : {}),
        ...(deps.tradeExecutor ? { tradeExecutor: deps.tradeExecutor } : {}),
      },
    };
  }

  return { ok: false, code: 503, error: 'network_not_configured' };
}

export function registerCasperGuardRoutes(app: FastifyInstance): void {
  app.get('/v1/casper-guard/capabilities', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    return reply.code(200).send(capabilities(app.deps.casperGuard));
  });

  app.get('/v1/casper-guard/setup-status', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    return reply.code(200).send(setupStatus(app.deps.casperGuard));
  });

  app.post('/v1/casper-guard/authorize-x402', async (request, reply) => {
    const deps = app.deps.casperGuard;
    const selection = selectNetworkSlot(deps, request.headers[CASPER_NETWORK_HEADER]);
    if (!selection.ok) return reply.code(selection.code).send({ error: selection.error });

    const auth = await authenticateAgent(app.deps.pg, request.headers.authorization);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = authorizeX402Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (parsed.data.agent_id !== auth.agent.agentId) {
      return reply.code(403).send({ error: 'tenant_mismatch' });
    }

    let intent: CasperGuardIntent;
    try {
      intent = intentFromPaymentRequired(parsed.data.payment_required);
    } catch {
      return reply.code(422).send({ error: 'invalid_casper_x402_requirements' });
    }
    if (intent.network !== selection.network) {
      return reply.code(409).send({ error: 'network_mismatch' });
    }

    const result = await authorizeWithStoredPolicy(app, deps, selection.slot, {
      orgId: auth.agent.orgId,
      agentId: auth.agent.agentId,
      idempotencyKey: parsed.data.idempotency_key,
      intent,
    });

    if (result.outcome === 'DENY') {
      return reply.code(403).send({
        outcome: 'DENY',
        decision_id: result.decisionId,
        reason: result.reason,
        signature_required: false,
      });
    }

    const headerValue = result.headers?.[CASPER_X402_HEADER_NAME];
    if (!headerValue) return reply.code(503).send({ error: 'casper_payment_header_unavailable' });
    const decision = await readCasperGuardDecision(app.deps.pg, result.decisionId);
    return reply.code(200).send({
      outcome: 'ALLOW',
      decision_id: result.decisionId,
      hold_id: result.holdId,
      payment_header: { name: CASPER_X402_HEADER_NAME, value: headerValue },
      signed_header_hash: result.signedHeaderHash,
      audit: auditSummary(decision),
    });
  });

  app.post('/v1/casper-guard/authorize-action', async (request, reply) => {
    const deps = app.deps.casperGuard;
    const selection = selectNetworkSlot(deps, request.headers[CASPER_NETWORK_HEADER]);
    if (!selection.ok) return reply.code(selection.code).send({ error: selection.error });

    const auth = await authenticateAgent(app.deps.pg, request.headers.authorization);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = authorizeActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (parsed.data.agent_id !== auth.agent.agentId) {
      return reply.code(403).send({ error: 'tenant_mismatch' });
    }

    let intent: CasperGuardIntent;
    try {
      intent = normalizeCasperGuardIntent(parsed.data.intent);
    } catch {
      return reply.code(422).send({ error: 'invalid_casper_guard_intent' });
    }
    if (intent.network !== selection.network) {
      return reply.code(409).send({ error: 'network_mismatch' });
    }

    const result = await authorizeWithStoredPolicy(app, deps, selection.slot, {
      orgId: auth.agent.orgId,
      agentId: auth.agent.agentId,
      idempotencyKey: parsed.data.idempotency_key,
      intent,
    });

    if (result.outcome === 'DENY') {
      return reply.code(403).send({
        outcome: 'DENY',
        decision_id: result.decisionId,
        reason: result.reason,
        signature_required: false,
      });
    }

    const decision = await readCasperGuardDecision(app.deps.pg, result.decisionId);
    const userBroadcastRequired = intent.kind === 'evm-transfer';
    return reply.code(200).send({
      outcome: 'ALLOW',
      decision_id: result.decisionId,
      hold_id: result.holdId,
      signed_header_hash: result.signedHeaderHash,
      ...(userBroadcastRequired ? { signature_required: true } : {}),
      audit: auditSummary(decision),
    });
  });

  app.get('/v1/casper-guard/decisions/:decisionId/audit', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const { decisionId } = request.params as { decisionId: string };
    const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
    if (
      !decision ||
      decision.orgId !== auth.principal.orgId ||
      decision.network !== resolvedNetwork.network
    ) {
      return reply.code(404).send({ error: 'decision_not_found' });
    }
    return reply.code(200).send(auditExport(decision));
  });

  app.get('/v1/casper-guard/decisions/:decisionId/status', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const { decisionId } = request.params as { decisionId: string };
    const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
    if (
      !decision ||
      decision.orgId !== auth.principal.orgId ||
      decision.network !== resolvedNetwork.network
    ) {
      return reply.code(404).send({ error: 'decision_not_found' });
    }
    return reply.code(200).send(decisionStatusExport(decision));
  });

  app.post('/v1/casper-guard/decisions/:decisionId/reconcile', async (request, reply) => {
    const deps = app.deps.casperGuard;
    const selection = selectNetworkSlot(deps, request.headers[CASPER_NETWORK_HEADER]);
    if (!selection.ok) return reply.code(selection.code).send({ error: selection.error });

    const auth = await authenticateAgent(app.deps.pg, request.headers.authorization);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = reconcileRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (parsed.data.agent_id !== auth.agent.agentId) {
      return reply.code(403).send({ error: 'tenant_mismatch' });
    }
    if (parsed.data.settlement.status === 'settled' && !selection.slot.anchorer) {
      return reply.code(503).send({ error: 'casper_guard_anchorer_unconfigured' });
    }

    const { decisionId } = request.params as { decisionId: string };
    try {
      const result = await reconcileCasperGuardDecision(
        {
          pool: app.deps.pg,
          redis: app.deps.redis,
          settlementReader: selection.slot.settlementReaderFactory
            ? composeSettlementReader(selection.slot.settlementReaderFactory(), () => settlementRead(parsed.data.settlement))
            : { read: () => Promise.resolve(settlementRead(parsed.data.settlement)) },
          ...(selection.slot.anchorer ? { anchorer: selection.slot.anchorer } : {}),
        },
        { decisionId, agentId: auth.agent.agentId },
      );
      const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
      return reply.code(200).send({ ...result, decision: decision ? decisionStatusExport(decision) : null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'casper_guard_reconcile_failed';
      if (message === 'casper_guard_decision_not_found') {
        return reply.code(404).send({ error: 'decision_not_found' });
      }
      if (message === 'casper_guard_decision_agent_mismatch') {
        return reply.code(403).send({ error: 'tenant_mismatch' });
      }
      throw err;
    }
  });
}

export function intentFromPaymentRequired(paymentRequiredInput: unknown): CasperGuardIntent {
  const parsed = paymentRequiredSchema.parse(paymentRequiredInput);
  const requirement = parsed.accepts[0] as CasperX402PaymentRequirements;
  const paymentRequired = parsed as unknown as Parameters<typeof validateCasperPaymentRequired>[0];
  validateCasperPaymentRequired(paymentRequired);
  const legacyResource = (requirement as { resource?: unknown }).resource;
  const resourceId =
    parsed.resource?.url ?? (typeof legacyResource === 'string' ? legacyResource : '');
  if (resourceId.length === 0) throw new Error('resource_required');
  return normalizeCasperGuardIntent({
    kind: 'x402-payment',
    network: requirement.network,
    resource_id: resourceId,
    amount: requirement.amount,
    asset: {
      kind: 'cep18',
      package_hash: requirement.asset,
      name: readTokenMetadata(requirement).name,
      version: readTokenMetadata(requirement).version,
    },
    pay_to: requirement.payTo,
    max_timeout_seconds: requirement.maxTimeoutSeconds,
    raw_requirement_hash: `sha256:${hashJson(paymentRequired)}`,
  });
}

export async function authorizeWithStoredPolicy(
  app: FastifyInstance,
  deps: CasperGuardDeps | undefined,
  slot: CasperGuardNetworkSlot,
  params: {
    orgId: string;
    agentId: string;
    idempotencyKey: string;
    intent: CasperGuardIntent;
  },
) {
  const { policy } = await resolveEffectivePolicy(app.deps.pg, app.deps.redis, {
    orgId: params.orgId,
    agentId: params.agentId,
  });

  const guardPolicy: CasperGuardPolicy = {
    policyRef: `${policy.policyId}@epoch${policy.policyEpoch}`,
    spendCap: policy.spend.spendCap.toString(),
    perTransactionMax: policy.spend.perTransactionMax.toString(),
    serviceScope: policy.spend.serviceScope,
    ...(deps?.serviceDestinations ? { serviceDestinations: deps.serviceDestinations } : {}),
    allowedActions: allowedActionsFromRails(policy.spend.railPermission),
    allowedNetworks: deps?.networks ?? [CASPER_X402_TESTNET_NETWORK],
    velocityLimitPerHour: policy.spend.velocityLimitPerHour,
    trade: deps?.trade ?? { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] },
  } satisfies CasperGuardPolicy;

  // LCP pre-authorization legal discovery
  const lcpResult = await lcpDiscover(params.intent.resourceId);
  const lcpPolicy = guardPolicy.lcp;

  if (!lcpResult.ok) {
    if (lcpResult.reason === 'hash_mismatch') {
      // Hash mismatch is always terminal — never failOpen
      return {
        outcome: 'DENY' as const,
        decisionId: newCasperGuardDecisionId(),
        reason: 'legal_terms_hash_mismatch' as const,
      };
    }
    // fetch_failed or parse_error: only block if lcp.required=true and failOpen=false
    if (lcpPolicy?.required && !lcpPolicy.failOpen) {
      return {
        outcome: 'DENY' as const,
        decisionId: newCasperGuardDecisionId(),
        reason: 'legal_context_fetch_failed' as const,
      };
    }
    // No lcp policy set, or failOpen=true: proceed without legal context
  } else {
    const ctx = lcpResult.context;
    const minTrust = lcpPolicy?.minTrustLevel ?? 1;

    // Merchant acceptanceRequired always overrides operator failOpen
    if (ctx.acceptanceRequired && ctx.trustLevel < minTrust) {
      return {
        outcome: 'DENY' as const,
        decisionId: newCasperGuardDecisionId(),
        reason: 'legal_acceptance_required' as const,
      };
    }

    // Attach LCP context to intent so it flows into computeCasperGuardDecisionHash via intent field
    (params.intent as Record<string, unknown>).lcp = {
      terms_url: ctx.termsUrl,
      atr_hash: ctx.atrHash,
      trust_level: ctx.trustLevel,
      fetched_at: ctx.fetchedAt,
      acceptance_required: ctx.acceptanceRequired,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await authorizeCasperGuardIntent(
    {
      pool: app.deps.pg,
      redis: app.deps.redis,
      signer: slot.signer!,
    },
    {
      decisionId: newCasperGuardDecisionId(),
      holdId: newCasperGuardHoldId(),
      idempotencyKey: params.idempotencyKey,
      orgId: params.orgId,
      agentId: params.agentId,
      intent: params.intent,
      policy: guardPolicy,
      now,
    },
  );

  // Emit fail-open telemetry copy to Redis stream so the monitoring feed shows AgentOps decisions.
  // Fire-and-forget (never awaited) — a telemetry failure must never block or fail an authorization.
  const telemetryBase = {
    agentId: params.agentId,
    orgId: params.orgId,
    railScheme: railForAction(params.intent.kind),
    railChain: params.intent.network ?? '',
    resourceId: params.intent.resourceId,
    amount: params.intent.amount ?? '0',
    ts: now,
  };
  if (result.outcome === 'ALLOW') {
    void emitDecisionSafe(app.deps.redis, { ...telemetryBase, paymentId: result.decisionId, outcome: 'ALLOW' });
  } else {
    void emitDecisionSafe(app.deps.redis, { ...telemetryBase, paymentId: result.decisionId, outcome: 'DENY', reason: result.reason as DenyReason });
  }

  return result;
}

function capabilities(deps: CasperGuardDeps | undefined) {
  return {
    product: 'AgentOps',
    networks: deps?.networks ?? [CASPER_X402_TESTNET_NETWORK],
    signer: {
      mode: deps?.signer?.kind ?? 'unconfigured',
      configured: deps?.signer !== undefined,
    },
    x402: { version: CASPER_X402_VERSION, header_name: CASPER_X402_HEADER_NAME },
    mcp: { url: deps?.mcpUrl ?? '/v1/casper-guard/mcp' },
    live_settlement: readiness(deps?.liveSettlement, 'casper_facilitator_not_configured'),
    odra: readiness(deps?.odra, 'odra_contract_not_bound'),
    trade: {
      max_slippage_bps: deps?.trade?.maxSlippageBps ?? 100,
      allowed_risk_labels: deps?.trade?.allowedRiskLabels ?? ['low', 'medium'],
    },
  };
}

function setupStatus(deps: CasperGuardDeps | undefined) {
  const signerReady = deps?.signer !== undefined;
  const live = readiness(deps?.liveSettlement, 'casper_facilitator_not_configured');
  const odra = readiness(deps?.odra, 'odra_contract_not_bound');
  const status = !signerReady ? 'blocked' : live.configured && odra.configured ? 'ready' : 'degraded';
  return {
    status,
    checks: {
      signer: signerReady
        ? { status: 'ready', mode: deps.signer!.kind }
        : { status: 'blocked', reason: 'casper_signer_not_configured' },
      live_settlement: live.configured
        ? { status: 'ready' }
        : { status: 'blocked', reason: live.reason },
      odra_anchor: odra.configured ? { status: 'ready' } : { status: 'blocked', reason: odra.reason },
      cspr_trade_policy: deps?.tradeExecutor?.available
        ? { status: 'ready' }
        : { status: 'blocked', reason: 'cspr_trade_mcp_not_configured' },
    },
  };
}

function settlementRead(settlement: z.infer<typeof settlementEvidenceSchema>): CasperGuardSettlementRead {
  switch (settlement.status) {
    case 'settled':
      return {
        status: 'settled',
        source: settlement.source,
        evidence: settlement.evidence,
        ...(settlement.tx_hash ? { txHash: settlement.tx_hash } : {}),
        ...(settlement.deploy_hash ? { deployHash: settlement.deploy_hash } : {}),
      };
    case 'pending':
    case 'ambiguous':
      return {
        status: settlement.status,
        source: settlement.source,
        evidence: settlement.evidence,
        ...(settlement.error_code ? { errorCode: settlement.error_code } : {}),
      };
    case 'failed':
    case 'expired':
      return {
        status: settlement.status,
        source: settlement.source,
        evidence: settlement.evidence,
        ...(settlement.error_code ? { errorCode: settlement.error_code } : {}),
      };
  }
}

function readiness(
  value: CasperGuardReadiness | undefined,
  defaultReason: string,
): { configured: boolean; reason?: string } {
  if (!value?.configured) return { configured: false, reason: value?.reason ?? defaultReason };
  return { configured: true };
}

export function allowedActionsFromRails(rails: readonly string[]): CasperGuardActionKind[] {
  const out = new Set<CasperGuardActionKind>();
  if (rails.includes('casper-x402')) out.add('x402-payment');
  if (rails.includes('cspr-trade')) out.add('cspr-trade');
  if (rails.includes('casper-deploy')) out.add('casper-deploy');
  if (rails.includes('evm-transfer')) out.add('evm-transfer');
  return [...out];
}

function readTokenMetadata(requirement: CasperX402PaymentRequirements): { name: string; version: string } {
  const extra = requirement.extra as { name?: unknown; version?: unknown };
  return { name: String(extra.name), version: String(extra.version) };
}

function auditSummary(decision: CasperGuardDecisionRecord | null) {
  if (!decision) return null;
  return {
    org_id: decision.orgId,
    agent_id: decision.agentId,
    status: decision.status,
    rail: railForAction(decision.actionKind),
    network: decision.network,
    amount: decision.amount,
    policy_ref: decision.policyRef,
    hold_id: decision.hold?.holdId ?? null,
  };
}

function decisionStatusExport(decision: CasperGuardDecisionRecord) {
  return {
    decision_id: decision.decisionId,
    outcome: decision.outcome,
    status: decision.status,
    reason_code: decision.reasonCode,
    action_kind: decision.actionKind,
    rail: railForAction(decision.actionKind),
    network: decision.network,
    resource_id: decision.resourceId,
    amount: decision.amount,
    hold: decision.hold
      ? { hold_id: decision.hold.holdId, status: decision.hold.status, amount: decision.hold.amount }
      : null,
    settlement: {
      tx_hash: decision.txHash,
      deploy_hash: decision.deployHash,
    },
    audit_anchor_count: decision.auditAnchors.filter((anchor) => anchor.status === 'confirmed').length,
  };
}

export function auditExport(decision: CasperGuardDecisionRecord) {
  return {
    decision: {
      decision_id: decision.decisionId,
      idempotency_key: decision.idempotencyKey,
      org_id: decision.orgId,
      agent_id: decision.agentId,
      outcome: decision.outcome,
      status: decision.status,
      reason_code: decision.reasonCode,
      action_kind: decision.actionKind,
      rail: railForAction(decision.actionKind),
      network: decision.network,
      resource_id: decision.resourceId,
      amount: decision.amount,
      asset_kind: decision.assetKind,
      asset_ref: decision.assetRef,
      destination: decision.destination,
      policy_ref: decision.policyRef,
      signer_kind: decision.signerKind,
      raw_requirement_hash: decision.rawRequirementHash,
      signed_header_hash: decision.signedHeaderHash,
      tx_hash: decision.txHash,
      deploy_hash: decision.deployHash,
      intent: decision.intent,
    },
    hold: decision.hold
      ? {
          hold_id: decision.hold.holdId,
          amount: decision.hold.amount,
          asset_kind: decision.hold.assetKind,
          asset_ref: decision.hold.assetRef,
          status: decision.hold.status,
        }
      : null,
    reconciliation_attempts: decision.reconciliationAttempts.map((attempt) => ({
      attempt_number: attempt.attemptNumber,
      source: attempt.source,
      status: attempt.status,
      evidence: attempt.evidence,
      error_code: attempt.errorCode,
    })),
    audit_anchors: decision.auditAnchors.map((anchor) => ({
      anchor_id: anchor.anchorId,
      anchor_kind: anchor.anchorKind,
      decision_hash: anchor.decisionHash,
      status: anchor.status,
      tx_hash: anchor.txHash,
    })),
  };
}

function railForAction(action: CasperGuardActionKind): string {
  switch (action) {
    case 'x402-payment':
      return 'casper-x402';
    case 'cspr-trade':
      return 'cspr-trade';
    case 'casper-deploy':
      return 'casper-deploy';
    case 'evm-transfer':
      return 'evm-transfer';
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
