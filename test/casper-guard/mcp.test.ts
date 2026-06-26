import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CasperGuardSigner } from '../../src/engines/casper-guard/policy.js';
import { readCasperGuardDecision } from '../../src/engines/casper-guard/store.js';
import { buildOracleApp, seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;

interface ToolsListResponse {
  result: { tools: Array<{ name: string; inputSchema?: unknown }> };
}

interface JsonRpcResult<T> {
  result: T;
}

interface AuthorizePaymentResult {
  outcome: 'ALLOW' | 'DENY';
  payment_header?: { name: string; value: string };
  decision_id: string;
}

interface DecisionStatusResult {
  decision_id: string;
  outcome: 'ALLOW' | 'DENY';
  status: string;
  hold: { status: string } | null;
}

interface AuditExportResult {
  decision: {
    decision_id: string;
    status: string;
    signed_header_hash: string | null;
  };
  hold: { amount: string; status: string } | null;
}

beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

function attachCasperGuardSigner(app: FastifyInstance, signer: CasperGuardSigner): void {
  (app.deps as typeof app.deps & { casperGuard: unknown }).casperGuard = {
    signer,
    networks: ['casper:casper-test'],
    mcpUrl: '/v1/casper-guard/mcp',
    liveSettlement: { configured: false, reason: 'casper_facilitator_not_configured' },
    odra: { configured: false, reason: 'odra_contract_not_bound' },
  };
}

function casperPaymentRequired(amount = '10') {
  return {
    x402Version: 2,
    resource: { url: 'svc:casper-paid-api', serviceName: 'Casper Paid API' },
    accepts: [
      {
        scheme: 'exact',
        network: 'casper:casper-test',
        amount,
        asset: 'a'.repeat(64),
        payTo: `00${'b'.repeat(64)}`,
        maxTimeoutSeconds: 900,
        extra: { name: 'Test CEP18', version: '1' },
      },
    ],
  };
}

async function dialCasperPolicy(app: FastifyInstance, agentId: string, adminKey: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/policy`,
    headers: { authorization: `Bearer ${adminKey}` },
    payload: {
      class: 'spend',
      rules: {
        spend_cap: '100',
        per_transaction_max: '100',
        service_scope: ['svc:casper-paid-api', 'cspr.trade:swap', 'casper:deploy:guard-registry'],
        rail_permission: ['casper-x402', 'cspr-trade', 'casper-deploy'],
        velocity_limit_per_hour: 100,
      },
    },
  });
  expect(res.statusCode).toBe(200);
}

function mcpCall(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } };
}

describe('Casper Guard MCP route', () => {
  it('lists the agent-facing Casper Guard tools with JSON schemas', async () => {
    if (!app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/mcp',
      payload: { jsonrpc: '2.0', id: 'tools', method: 'tools/list' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<ToolsListResponse>();
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'casper_guard_policy_check',
      'casper_guard_authorize_payment',
      'casper_guard_authorize_action',
      'casper_guard_decision_status',
      'casper_guard_audit_export',
      'casper_guard_reconcile',
    ]);
    expect(body.result.tools[1]).toMatchObject({
      name: 'casper_guard_authorize_payment',
      inputSchema: { type: 'object' },
    });
  });

  it('authorizes a Casper x402 payment through MCP using the same persisted decision path', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, orgId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy(app, agentId, adminKey);
    attachCasperGuardSigner(app, {
      kind: 'local-testnet',
      sign: () =>
        Promise.resolve({
          signedHeaderHash: 'sha256:mcp-payment-signature',
          headers: { 'PAYMENT-SIGNATURE': 'mcp-payment-signature' },
        }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/mcp',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: mcpCall('casper_guard_authorize_payment', {
        agent_id: agentId,
        idempotency_key: 'idem_mcp_payment',
        payment_required: casperPaymentRequired('10'),
      }),
    });

    expect(res.statusCode).toBe(200);
    const result = res.json<JsonRpcResult<AuthorizePaymentResult>>().result;
    expect(result).toMatchObject({
      outcome: 'ALLOW',
      payment_header: { name: 'PAYMENT-SIGNATURE', value: 'mcp-payment-signature' },
    });
    const decision = await readCasperGuardDecision(stores.pool, result.decision_id);
    expect(decision).toMatchObject({
      orgId,
      agentId,
      status: 'SIGNED',
      hold: { amount: '10', status: 'RESERVED' },
    });
  });

  it('returns decision status and audit export through MCP from durable records', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy(app, agentId, adminKey);
    attachCasperGuardSigner(app, {
      kind: 'local-testnet',
      sign: () =>
        Promise.resolve({
          signedHeaderHash: 'sha256:mcp-audit-signature',
          headers: { 'PAYMENT-SIGNATURE': 'mcp-audit-payment-signature' },
        }),
    });

    const authorized = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/mcp',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: mcpCall('casper_guard_authorize_payment', {
        agent_id: agentId,
        idempotency_key: 'idem_mcp_audit',
        payment_required: casperPaymentRequired('12'),
      }),
    });
    const decisionId = authorized.json<JsonRpcResult<AuthorizePaymentResult>>().result.decision_id;

    const status = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/mcp',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: mcpCall('casper_guard_decision_status', { decision_id: decisionId }),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json<JsonRpcResult<DecisionStatusResult>>().result).toMatchObject({
      decision_id: decisionId,
      outcome: 'ALLOW',
      status: 'SIGNED',
      hold: { status: 'RESERVED' },
    });

    const audit = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/mcp',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: mcpCall('casper_guard_audit_export', { decision_id: decisionId }),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<JsonRpcResult<AuditExportResult>>().result).toMatchObject({
      decision: {
        decision_id: decisionId,
        status: 'SIGNED',
        signed_header_hash: 'sha256:mcp-audit-signature',
      },
      hold: { amount: '12', status: 'RESERVED' },
    });
  });
});
