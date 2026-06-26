import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lcpDiscover } from '../../lib/lcp/discover.js';
import { authenticateAgent } from '../oracle/auth.js';
import { normalizeCasperGuardIntent } from './types.js';
import {
  auditExport,
  authorizeWithStoredPolicy,
  intentFromPaymentRequired,
  allowedActionsFromRails,
  type CasperGuardDeps,
} from './routes.js';
import { CASPER_X402_TESTNET_NETWORK } from '../../lib/casper/x402.js';
import {
  markDecisionSettledByUser,
  readCasperGuardDecision,
  settleCasperGuardHold,
  type CasperGuardDecisionRecord,
} from './store.js';
import {
  reconcileCasperGuardDecision,
  computeCasperGuardDecisionHash,
} from './reconcile-worker.js';
import { composeSettlementReader } from '../../lib/casper/settlement-reader.js';
import { settleHold } from '../ledger/window.js';
import { CASPER_X402_HEADER_NAME } from '../../lib/casper/x402.js';

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const callSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).default({}),
});

// Shared sub-schemas reused across intent variants.
const ASSET_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      description: 'Native CSPR asset',
      properties: {
        kind: { type: 'string', enum: ['native'] },
        symbol: { type: 'string', enum: ['CSPR'] },
      },
      required: ['kind', 'symbol'],
    },
    {
      type: 'object',
      description: 'CEP-18 fungible token (e.g. USDC on Casper)',
      properties: {
        kind: { type: 'string', enum: ['cep18'] },
        package_hash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: '64-char hex contract package hash' },
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'package_hash', 'name', 'version'],
    },
    {
      type: 'object',
      description: 'Native ETH asset (EVM networks)',
      properties: {
        kind: { type: 'string', enum: ['native-eth'] },
        symbol: { type: 'string', enum: ['ETH'] },
      },
      required: ['kind', 'symbol'],
    },
    {
      type: 'object',
      description: 'ERC-20 token (EVM networks)',
      properties: {
        kind: { type: 'string', enum: ['erc20'] },
        address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        name: { type: 'string', minLength: 1 },
        decimals: { type: 'integer', minimum: 0, maximum: 18 },
      },
      required: ['kind', 'address', 'name', 'decimals'],
    },
  ],
} as const;

const INTENT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      title: 'casper-deploy',
      description: 'Native Casper deploy — transfer, contract-call, or contract-install. Use resource_id "casper:deploy:guard-registry".',
      properties: {
        kind: { type: 'string', enum: ['casper-deploy'] },
        network: { type: 'string', enum: ['casper:casper-test'], description: 'Must be "casper:casper-test" — mainnet is not permitted.' },
        resource_id: { type: 'string', description: 'Must be in the agent\'s service_scope. Use "casper:deploy:guard-registry" for Casper deploys.' },
        amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Amount in motes (integer string, no decimals).' },
        asset: { ...ASSET_SCHEMA, description: 'Use {"kind":"native","symbol":"CSPR"} for native CSPR transfers.' },
        deploy_kind: { type: 'string', enum: ['transfer', 'contract-call', 'contract-install'] },
        target: { type: 'string', minLength: 1, description: 'Recipient account hash (66-char: "00" + 64-char hex) or contract address.' },
        entry_point: { type: 'string', description: 'Entry point name for contract-call deploys.' },
        args_hash: { type: 'string', description: 'SHA-256 hash of the deploy args for audit.' },
      },
      required: ['kind', 'network', 'resource_id', 'amount', 'asset', 'deploy_kind', 'target'],
    },
    {
      type: 'object',
      title: 'cspr-trade',
      description: 'CSPR.trade DEX swap. Fetch quote/slippage from CSPR.trade first, then submit here. Use resource_id "cspr.trade:swap".',
      properties: {
        kind: { type: 'string', enum: ['cspr-trade'] },
        network: { type: 'string', enum: ['casper:casper-test'], description: 'Must be "casper:casper-test" — mainnet is not permitted.' },
        resource_id: { type: 'string', description: 'Must be "cspr.trade:swap".' },
        amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Amount of from_asset in smallest unit (motes for CSPR).' },
        from_asset: { ...ASSET_SCHEMA, description: 'Asset being sold.' },
        to_asset: { ...ASSET_SCHEMA, description: 'Asset being bought.' },
        min_received: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Minimum to_asset amount to accept (in smallest unit). Prevents slippage above tolerance.' },
        slippage_bps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Slippage tolerance in basis points (100 = 1%). Must be ≤ policy maxSlippageBps.' },
        route_id: { type: 'string', minLength: 1, description: 'Route identifier from CSPR.trade get_quote / estimate_slippage response.' },
        risk_label: { type: 'string', description: 'Risk label from CSPR.trade quote ("low", "medium", "high"). Required for policy trade_risk check.' },
      },
      required: ['kind', 'network', 'resource_id', 'amount', 'from_asset', 'to_asset', 'min_received', 'slippage_bps', 'route_id'],
    },
    {
      type: 'object',
      title: 'evm-transfer',
      description: 'EVM chain transfer (ETH or ERC-20). Caller broadcasts from their own wallet then reconciles with tx_hash.',
      properties: {
        kind: { type: 'string', enum: ['evm-transfer'] },
        network: { type: 'string', enum: ['evm:sepolia', 'evm:base-sepolia'] },
        resource_id: { type: 'string', minLength: 1 },
        amount: { type: 'string', pattern: '^[1-9][0-9]*$' },
        asset: ASSET_SCHEMA,
        to: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'EVM recipient address.' },
      },
      required: ['kind', 'network', 'resource_id', 'amount', 'asset', 'to'],
    },
  ],
} as const;

const TOOL_DESCRIPTORS = [
  {
    name: 'casper_guard_policy_check',
    description: 'Dry-run a Casper Guard intent against the agent policy without signing. Returns allowed_resource_ids and allowed_networks on DENY so the caller can correct the intent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        intent: INTENT_SCHEMA,
      },
      required: ['agent_id', 'intent'],
    },
  },
  {
    name: 'casper_guard_authorize_payment',
    description: 'Authorize Casper x402 payment requirements and return PAYMENT-SIGNATURE on ALLOW.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 160 },
        payment_required: { type: 'object' },
      },
      required: ['agent_id', 'idempotency_key', 'payment_required'],
    },
  },
  {
    name: 'casper_guard_authorize_action',
    description: [
      'Authorize a CSPR.trade swap, Casper deploy, or EVM transfer intent.',
      'Policy enforcement always runs on Casper; the transaction itself executes on the network in the intent.',
      'MAINNET IS BLOCKED — only casper:casper-test, evm:sepolia, and evm:base-sepolia are accepted.',
      'Field names use snake_case (e.g. deploy_kind, resource_id, from_asset) — camelCase is rejected.',
      'For casper-deploy: after ALLOW, sign the deploy locally and broadcast it, then call casper_guard_reconcile with the tx_hash.',
      'For cspr-trade: call casper_guard_reconcile without tx_hash — settlement is read from chain.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 160 },
        intent: INTENT_SCHEMA,
      },
      required: ['agent_id', 'idempotency_key', 'intent'],
    },
  },
  {
    name: 'casper_guard_decision_status',
    description: 'Read the durable status for a Casper Guard decision.',
    inputSchema: {
      type: 'object',
      properties: { decision_id: { type: 'string' } },
      required: ['decision_id'],
    },
  },
  {
    name: 'casper_guard_audit_export',
    description: 'Export judge-verifiable audit JSON for a Casper Guard decision.',
    inputSchema: {
      type: 'object',
      properties: { decision_id: { type: 'string' } },
      required: ['decision_id'],
    },
  },
  {
    name: 'casper_guard_reconcile',
    description: [
      'Record settlement for an ALLOW decision and anchor the proof to the Casper GuardRegistry.',
      'casper-deploy / evm-transfer: broadcast from your own wallet FIRST, then call with tx_hash.',
      'x402-payment / cspr-trade: call WITHOUT tx_hash — the platform reads settlement from chain.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        decision_id: { type: 'string' },
        tx_hash: {
          type: 'string',
          description: 'Deploy/transaction hash returned by your wallet after broadcasting. Required for casper-deploy and evm-transfer; omit for x402-payment and cspr-trade.',
        },
      },
      required: ['agent_id', 'decision_id'],
    },
  },
  {
    name: 'casper_guard_legal_context',
    description: [
      'Fetch and verify the Legal Context Protocol (LCP) document for a service domain.',
      'Returns the legal terms URL, atrHash (SHA-256 proof of terms at transaction time), trust level, and whether acceptance is required.',
      'Call this BEFORE casper_guard_authorize_payment or casper_guard_authorize_action to surface legal terms the agent should reason about.',
      'If atrHash is present and verified, trust_level=2+ guarantees the exact document the agent saw is cryptographically committed to the on-chain GuardRegistry anchor.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        resource_id: {
          type: 'string',
          description: 'The resource URL or service identifier to fetch LCP context for (e.g. "https://api.weather.example/premium").',
        },
        min_trust_level: {
          type: 'number',
          enum: [1, 2, 3, 4],
          description: 'Optional minimum trust level required. Returns an error if the discovered trust level is below this.',
        },
      },
      required: ['resource_id'],
    },
  },
] as const;

export function registerCasperGuardMcpRoute(app: FastifyInstance): void {
  app.post('/v1/casper-guard/mcp', async (request, reply) => {
    const parsed = rpcSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(rpcError(null, -32600, 'invalid_request'));
    }
    const rpc = parsed.data;

    // MCP protocol handshake — must respond before any tools/list or tools/call is accepted.
    // mcp-remote, Claude Code, and all compliant clients send this first.
    if (rpc.method === 'initialize') {
      return reply.code(200).send(rpcResult(rpc.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'casper-guard', version: '1.0.0' },
      }));
    }

    // One-way notification sent by clients after a successful initialize — no response body needed.
    if (rpc.method === 'notifications/initialized') {
      return reply.code(200).send({ jsonrpc: '2.0' });
    }

    if (rpc.method === 'tools/list') {
      return reply.code(200).send(rpcResult(rpc.id, { tools: TOOL_DESCRIPTORS }));
    }

    if (rpc.method !== 'tools/call') {
      return reply.code(200).send(rpcError(rpc.id, -32601, 'method_not_found'));
    }

    const call = callSchema.safeParse(rpc.params);
    if (!call.success) {
      return reply.code(200).send(rpcError(rpc.id, -32602, 'invalid_params'));
    }

    const deps = app.deps.casperGuard;
    if (!deps?.signer && requiresSigner(call.data.name)) {
      return reply.code(200).send(rpcError(rpc.id, -32000, 'casper_guard_signer_not_configured'));
    }

    switch (call.data.name) {
      case 'casper_guard_authorize_payment':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await authorizePaymentTool(app, deps!, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_authorize_action':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await authorizeActionTool(app, deps!, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_decision_status':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await decisionStatusTool(app, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_audit_export':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await auditExportTool(app, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_policy_check':
        return reply.code(200).send(rpcToolResult(rpc.id, await policyCheckTool(app, deps, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_reconcile':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await reconcileTool(app, deps!, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_legal_context':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await legalContextTool(call.data.arguments)));
      default:
        return reply.code(200).send(rpcError(rpc.id, -32602, 'unknown_tool'));
    }
  });
}

async function authorizePaymentTool(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const idempotencyKey = requireString(args.idempotency_key, 'idempotency_key');
  const intent = intentFromPaymentRequired(args.payment_required);
  const result = await authorizeWithStoredPolicy(app, deps, {
    orgId: auth.orgId,
    agentId: auth.agentId,
    idempotencyKey,
    intent,
  });
  if (result.outcome === 'DENY') {
    return { outcome: 'DENY', decision_id: result.decisionId, reason: result.reason, signature_required: false };
  }
  const headerValue = result.headers?.[CASPER_X402_HEADER_NAME];
  if (!headerValue) throw new Error('casper_payment_header_unavailable');
  return {
    outcome: 'ALLOW',
    decision_id: result.decisionId,
    hold_id: result.holdId,
    payment_header: { name: CASPER_X402_HEADER_NAME, value: headerValue },
    signed_header_hash: result.signedHeaderHash,
  };
}

async function authorizeActionTool(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const idempotencyKey = requireString(args.idempotency_key, 'idempotency_key');
  const intent = normalizeCasperGuardIntent(args.intent);
  const result = await authorizeWithStoredPolicy(app, deps, {
    orgId: auth.orgId,
    agentId: auth.agentId,
    idempotencyKey,
    intent,
  });
  if (result.outcome === 'DENY') {
    return { outcome: 'DENY', decision_id: result.decisionId, reason: result.reason, signature_required: false };
  }
  return {
    outcome: 'ALLOW',
    decision_id: result.decisionId,
    hold_id: result.holdId,
    signed_header_hash: result.signedHeaderHash,
    signature_required: true,
  };
}

async function decisionStatusTool(
  app: FastifyInstance,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await authenticateAgent(app.deps.pg, authz);
  if (!auth.ok) throw new Error(auth.reason);
  const decision = await readTenantDecision(app, auth.agent.orgId, requireString(args.decision_id, 'decision_id'));
  return decisionStatus(decision);
}

async function auditExportTool(
  app: FastifyInstance,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await authenticateAgent(app.deps.pg, authz);
  if (!auth.ok) throw new Error(auth.reason);
  return auditExport(await readTenantDecision(app, auth.agent.orgId, requireString(args.decision_id, 'decision_id')));
}

async function policyCheckTool(
  app: FastifyInstance,
  deps: CasperGuardDeps | undefined,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const intent = normalizeCasperGuardIntent(args.intent);
  const { policy } = await import('../enforcement/policy-epoch-guard.js').then((m) =>
    m.resolveEffectivePolicy(app.deps.pg, app.deps.redis, {
      orgId: auth.orgId,
      agentId: auth.agentId,
    }),
  );

  const allowedNetworks = deps?.networks ?? [CASPER_X402_TESTNET_NETWORK];
  const allowedActions = allowedActionsFromRails(policy.spend.railPermission);
  const serviceScope = policy.spend.serviceScope;

  if (!allowedActions.includes(intent.kind)) {
    return { outcome: 'DENY', reason: 'action_not_allowed', agent_id: auth.agentId, policy_id: policy.policyId };
  }
  if (!allowedNetworks.includes(intent.network)) {
    return { outcome: 'DENY', reason: 'network_not_allowed', agent_id: auth.agentId, policy_id: policy.policyId, allowed_networks: allowedNetworks };
  }
  if (!serviceScope.includes(intent.resourceId)) {
    return { outcome: 'DENY', reason: 'service_not_allowed', agent_id: auth.agentId, policy_id: policy.policyId, allowed_resource_ids: serviceScope };
  }

  return {
    outcome: 'CHECK',
    agent_id: auth.agentId,
    action_kind: intent.kind,
    policy_epoch: policy.policyEpoch,
    policy_id: policy.policyId,
    allowed_networks: allowedNetworks,
    allowed_resource_ids: serviceScope,
  };
}

async function reconcileTool(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const decisionId = requireString(args.decision_id, 'decision_id');
  // tx_hash is provided by the user after they broadcast their own transaction.
  // For casper-deploy and evm-transfer this is required — the user signs and sends from their wallet.
  const userTxHash = typeof args.tx_hash === 'string' && args.tx_hash.length > 0 ? args.tx_hash : null;

  const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
  if (!decision) throw new Error('casper_guard_decision_not_found');
  if (decision.agentId !== auth.agentId) throw new Error('casper_guard_decision_agent_mismatch');

  // User-signed settlement path — covers casper-deploy (native CSPR) and evm-transfer (ETH/ERC-20).
  // The user broadcast the tx from their own wallet and passes the tx_hash here.
  // Platform role: record the hash, release the hold, anchor the decision proof to Casper.
  if (
    decision.outcome === 'ALLOW' &&
    (decision.actionKind === 'casper-deploy' || decision.actionKind === 'evm-transfer') &&
    (decision.status === 'RESERVED' || decision.status === 'SIGNED') &&
    userTxHash
  ) {
    await markDecisionSettledByUser(app.deps.pg, { decisionId, txHash: userTxHash });
    await Promise.all([
      settleHold(app.deps.redis, auth.agentId, decisionId),
      settleCasperGuardHold(app.deps.pg, decisionId),
    ]);

    let anchorTxHash: string | null = null;
    if (deps.anchorer) {
      const refreshed = await readCasperGuardDecision(app.deps.pg, decisionId);
      if (refreshed && refreshed.status === 'SETTLED') {
        const decisionHash = computeCasperGuardDecisionHash(refreshed);
        try {
          const { txHash } = await deps.anchorer.anchorDecision({ decisionId, decisionHash, decision: refreshed });
          anchorTxHash = txHash;
        } catch { /* anchor failed — decision is still settled */ }
      }
    }

    return {
      decision_id: decisionId,
      status: 'SETTLED',
      settled: true,
      anchored: anchorTxHash !== null,
      tx_hash: userTxHash,
      deploy_hash: userTxHash,
      anchor_tx_hash: anchorTxHash,
    };
  }

  // If the user did not provide tx_hash but the decision needs one, tell them explicitly.
  if (
    decision.outcome === 'ALLOW' &&
    (decision.actionKind === 'casper-deploy' || decision.actionKind === 'evm-transfer') &&
    (decision.status === 'RESERVED' || decision.status === 'SIGNED') &&
    !userTxHash
  ) {
    return {
      decision_id: decisionId,
      status: 'AWAITING_USER_TX',
      settled: false,
      anchored: false,
      tx_hash: null,
      message: `Broadcast the transaction from your own wallet first, then call casper_guard_reconcile again with tx_hash set to the transaction hash you received.`,
    };
  }

  // x402-payment and cspr-trade go through the normal FSM settlement reader path.
  const settlementReader = deps.settlementReaderFactory
    ? composeSettlementReader(
        deps.settlementReaderFactory(),
        () => ({ status: 'pending', source: 'casper-rpc' as const, evidence: {} }),
      )
    : { read: async () => ({ status: 'pending' as const, source: 'casper-rpc' as const, evidence: {} }) };

  const result = await reconcileCasperGuardDecision(
    {
      pool: app.deps.pg,
      redis: app.deps.redis,
      settlementReader,
      ...(deps.anchorer ? { anchorer: deps.anchorer } : {}),
    },
    { decisionId, agentId: auth.agentId },
  );

  const finalDecision = await readCasperGuardDecision(app.deps.pg, decisionId);
  return {
    decision_id: result.decisionId,
    status: result.status,
    settled: result.settled,
    anchored: result.anchored,
    tx_hash: finalDecision?.txHash ?? null,
    deploy_hash: finalDecision?.deployHash ?? null,
    anchor_tx_hash: finalDecision?.auditAnchors?.find((a) => a.status === 'confirmed')?.txHash ?? null,
  };
}

async function requireAgent(app: FastifyInstance, authz: string | undefined, requestedAgentId: unknown) {
  const auth = await authenticateAgent(app.deps.pg, authz);
  if (!auth.ok) throw new Error(auth.reason);
  const agentId = requireString(requestedAgentId, 'agent_id');
  if (auth.agent.agentId !== agentId) throw new Error('tenant_mismatch');
  return auth.agent;
}

async function readTenantDecision(
  app: FastifyInstance,
  orgId: string,
  decisionId: string,
): Promise<CasperGuardDecisionRecord> {
  const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
  if (!decision || decision.orgId !== orgId) throw new Error('decision_not_found');
  return decision;
}

async function legalContextTool(args: Record<string, unknown>) {
  const resourceId = requireString(args.resource_id, 'resource_id');
  const minTrustLevel =
    typeof args.min_trust_level === 'number' &&
    [1, 2, 3, 4].includes(args.min_trust_level)
      ? (args.min_trust_level as 1 | 2 | 3 | 4)
      : null;

  const result = await lcpDiscover(resourceId);

  if (!result.ok) {
    return { ok: false, reason: result.reason, resource_id: resourceId };
  }

  const ctx = result.context;

  if (minTrustLevel !== null && ctx.trustLevel < minTrustLevel) {
    return {
      ok: false,
      reason: 'trust_level_insufficient',
      resource_id: resourceId,
      discovered_trust_level: ctx.trustLevel,
      required_trust_level: minTrustLevel,
    };
  }

  return {
    ok: true,
    resource_id: resourceId,
    terms_url: ctx.termsUrl,
    atr_hash: ctx.atrHash,
    trust_level: ctx.trustLevel,
    fetched_at: ctx.fetchedAt,
    acceptance_required: ctx.acceptanceRequired,
    hash_verified: ctx.hashVerified,
    note: ctx.hashVerified
      ? 'atrHash verified — this exact document will be committed to the on-chain GuardRegistry anchor.'
      : 'No atrHash — terms fetched informational only.',
  };
}

function decisionStatus(decision: CasperGuardDecisionRecord) {
  return {
    decision_id: decision.decisionId,
    outcome: decision.outcome,
    status: decision.status,
    reason_code: decision.reasonCode,
    action_kind: decision.actionKind,
    network: decision.network,
    amount: decision.amount,
    hold: decision.hold
      ? { hold_id: decision.hold.holdId, status: decision.hold.status, amount: decision.hold.amount }
      : null,
  };
}

function requiresSigner(name: string): boolean {
  return name === 'casper_guard_authorize_payment' || name === 'casper_guard_authorize_action';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid_${field}`);
  return value;
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

// MCP spec: tools/call responses must wrap output in content[].text, not as bare result fields.
// Clients (Claude Code, mcp-remote) parse result.content[0].text — a bare result object is ignored.
function rpcToolResult(id: string | number | null | undefined, data: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text: JSON.stringify(data) }] },
  };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
