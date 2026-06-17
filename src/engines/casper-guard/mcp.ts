import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateAgent } from '../oracle/auth.js';
import { normalizeCasperGuardIntent } from './types.js';
import {
  auditExport,
  authorizeWithStoredPolicy,
  intentFromPaymentRequired,
  type CasperGuardDeps,
} from './routes.js';
import { readCasperGuardDecision, type CasperGuardDecisionRecord } from './store.js';
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

const TOOL_DESCRIPTORS = [
  {
    name: 'casper_guard_policy_check',
    description: 'Dry-run a Casper Guard intent against the agent policy without signing.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        intent: { type: 'object' },
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
        idempotency_key: { type: 'string' },
        payment_required: { type: 'object' },
      },
      required: ['agent_id', 'idempotency_key', 'payment_required'],
    },
  },
  {
    name: 'casper_guard_authorize_action',
    description: 'Authorize a CSPR.trade or direct Casper action intent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        idempotency_key: { type: 'string' },
        intent: { type: 'object' },
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
] as const;

export function registerCasperGuardMcpRoute(app: FastifyInstance): void {
  app.post('/v1/casper-guard/mcp', async (request, reply) => {
    const parsed = rpcSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(rpcError(null, -32600, 'invalid_request'));
    }
    const rpc = parsed.data;

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
          .send(rpcResult(rpc.id, await authorizePaymentTool(app, deps!, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_authorize_action':
        return reply
          .code(200)
          .send(rpcResult(rpc.id, await authorizeActionTool(app, deps!, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_decision_status':
        return reply
          .code(200)
          .send(rpcResult(rpc.id, await decisionStatusTool(app, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_audit_export':
        return reply
          .code(200)
          .send(rpcResult(rpc.id, await auditExportTool(app, request.headers.authorization, call.data.arguments)));
      case 'casper_guard_policy_check':
        return reply.code(200).send(rpcResult(rpc.id, await policyCheckTool(app, request.headers.authorization, call.data.arguments)));
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
  return {
    outcome: 'CHECK',
    agent_id: auth.agentId,
    action_kind: intent.kind,
    policy_epoch: policy.policyEpoch,
    policy_id: policy.policyId,
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

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
