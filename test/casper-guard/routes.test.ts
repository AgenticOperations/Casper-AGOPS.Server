import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readCasperGuardDecision } from '../../src/engines/casper-guard/store.js';
import type { CasperGuardSigner } from '../../src/engines/casper-guard/policy.js';
import { seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import { buildOracleApp } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;

interface CasperCapabilitiesResponse {
  product: string;
  networks: string[];
  signer: { mode: string; configured: boolean };
  x402: { version: number; header_name: string };
  mcp: { url: string };
  live_settlement: { configured: boolean; reason?: string };
  odra: { configured: boolean; reason?: string };
  trade: { max_slippage_bps: number; allowed_risk_labels: string[] };
}

interface CasperSetupResponse {
  status: string;
  checks: {
    signer: { status: string };
    live_settlement: { status: string; reason?: string };
    odra_anchor: { status: string; reason?: string };
    cspr_trade_policy: { status: string; reason?: string };
  };
}

interface CasperAuthorizeResponse {
  outcome: 'ALLOW';
  payment_header: { name: string; value: string };
  decision_id: string;
  hold_id: string;
  audit: {
    org_id: string;
    agent_id: string;
    status: string;
    rail: string;
    network: string;
  };
}

interface CasperDenyResponse {
  outcome: 'DENY';
  reason: string;
  signature_required: false;
}

interface CasperAuditResponse {
  decision: {
    decision_id: string;
    org_id: string;
    agent_id: string;
    outcome: string;
    status: string;
    amount: string;
    rail: string;
    signed_header_hash: string | null;
  };
  hold: { status: string; amount: string } | null;
  reconciliation_attempts: unknown[];
  audit_anchors: unknown[];
}

interface CasperDecisionStatusResponse {
  decision_id: string;
  outcome: string;
  status: string;
  rail: string;
  amount: string;
  hold: { hold_id: string; status: string; amount: string } | null;
  settlement: { tx_hash: string | null; deploy_hash: string | null };
  audit_anchor_count: number;
}

interface CasperReconcileResponse {
  decisionId: string;
  status: string;
  settled: boolean;
  anchored: boolean;
  decision: CasperDecisionStatusResponse;
}

beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

function casperPaymentRequired(amount = '10') {
  return {
    x402Version: 2,
    resource: {
      url: 'svc:casper-paid-api',
      serviceName: 'Casper Paid API',
    },
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

async function dialCasperPolicy(input: {
  app: FastifyInstance;
  agentId: string;
  adminKey: string;
  spendCap?: string;
  perTransactionMax?: string;
}) {
  const res = await input.app.inject({
    method: 'POST',
    url: `/v1/agents/${input.agentId}/policy`,
    headers: { authorization: `Bearer ${input.adminKey}` },
    payload: {
      class: 'spend',
      rules: {
        spend_cap: input.spendCap ?? '100',
        per_transaction_max: input.perTransactionMax ?? '100',
        service_scope: ['svc:casper-paid-api', 'cspr.trade:swap', 'casper:deploy:guard-registry'],
        rail_permission: ['casper-x402', 'cspr-trade', 'casper-deploy'],
        velocity_limit_per_hour: 100,
      },
    },
  });
  expect(res.statusCode).toBe(200);
}

function attachCasperGuardSigner(
  app: FastifyInstance,
  signer: CasperGuardSigner,
  anchorer?: { anchorDecision(input: unknown): Promise<{ txHash: string }> },
): void {
  (app.deps as typeof app.deps & { casperGuard: unknown }).casperGuard = {
    signer,
    networks: ['casper:casper-test'],
    mcpUrl: '/v1/casper-guard/mcp',
    liveSettlement: { configured: false, reason: 'casper_facilitator_not_configured' },
    odra: { configured: false, reason: 'odra_contract_not_bound' },
    ...(anchorer ? { anchorer } : {}),
  };
}

describe('AgentOps HTTP routes', () => {
  it('reports capabilities and honest setup status for the client', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    attachCasperGuardSigner(app, {
      kind: 'local-testnet',
      sign: () => Promise.resolve({ signedHeaderHash: 'sha256:not-used' }),
    });

    const caps = await app.inject({
      method: 'GET',
      url: '/v1/casper-guard/capabilities',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(caps.statusCode).toBe(200);
    expect(caps.json<CasperCapabilitiesResponse>()).toMatchObject({
      product: 'AgentOps',
      networks: ['casper:casper-test'],
      signer: { mode: 'local-testnet', configured: true },
      x402: { version: 2, header_name: 'PAYMENT-SIGNATURE' },
      mcp: { url: '/v1/casper-guard/mcp' },
      live_settlement: { configured: false, reason: 'casper_facilitator_not_configured' },
      odra: { configured: false, reason: 'odra_contract_not_bound' },
      trade: { max_slippage_bps: 100, allowed_risk_labels: ['low', 'medium'] },
    });

    const setup = await app.inject({
      method: 'GET',
      url: '/v1/casper-guard/setup-status',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json<CasperSetupResponse>()).toMatchObject({
      status: 'degraded',
      checks: {
        signer: { status: 'ready' },
        live_settlement: { status: 'blocked', reason: 'casper_facilitator_not_configured' },
        odra_anchor: { status: 'blocked', reason: 'odra_contract_not_bound' },
        cspr_trade_policy: { status: 'blocked', reason: 'cspr_trade_mcp_not_configured' },
      },
    });
  });

  it('authorizes Casper x402 with stored server-side policy and returns audit fields', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, orgId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    let signCalls = 0;
    attachCasperGuardSigner(app, {
      kind: 'local-testnet',
      sign: () => {
        signCalls += 1;
        return Promise.resolve({
          signedHeaderHash: 'sha256:payment-signature',
          headers: { 'PAYMENT-SIGNATURE': 'test-payment-signature' },
        });
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_route_x402_allow',
        payment_required: casperPaymentRequired('10'),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CasperAuthorizeResponse>();
    expect(body).toMatchObject({
      outcome: 'ALLOW',
      payment_header: { name: 'PAYMENT-SIGNATURE', value: 'test-payment-signature' },
      audit: {
        org_id: orgId,
        agent_id: agentId,
        status: 'SIGNED',
        rail: 'casper-x402',
        network: 'casper:casper-test',
      },
    });
    expect(body.decision_id).toMatch(/^cgd_/);
    expect(body.hold_id).toMatch(/^cgh_/);
    expect(signCalls).toBe(1);

    const persisted = await readCasperGuardDecision(stores.pool, body.decision_id);
    expect(persisted).toMatchObject({
      orgId,
      agentId,
      status: 'SIGNED',
      hold: { status: 'RESERVED', amount: '10' },
    });
  });

  it('denies Casper actions with stored policy and never calls signer', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey, perTransactionMax: '5' });
    let signCalls = 0;
    attachCasperGuardSigner(app, {
      kind: 'local-testnet',
      sign: () => {
        signCalls += 1;
        return Promise.resolve({ signedHeaderHash: 'sha256:should-not-sign' });
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-action',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_route_trade_deny',
        intent: {
          kind: 'cspr-trade',
          network: 'casper:casper-test',
          resource_id: 'cspr.trade:swap',
          amount: '10',
          from_asset: { kind: 'native', symbol: 'CSPR' },
          to_asset: { kind: 'cep18', package_hash: 'c'.repeat(64), name: 'Token', version: '1' },
          min_received: '9',
          slippage_bps: 50,
          route_id: 'route_1',
          risk_label: 'medium',
        },
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<CasperDenyResponse>()).toMatchObject({
      outcome: 'DENY',
      reason: 'per_transaction_max_exceeded',
      signature_required: false,
    });
    expect(signCalls).toBe(0);
  });

  it('exports judge-verifiable audit JSON for a AgentOps decision', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, orgId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    attachCasperGuardSigner(app, {
      kind: 'local-testnet',
      sign: () =>
        Promise.resolve({
          signedHeaderHash: 'sha256:audit-signature',
          headers: { 'PAYMENT-SIGNATURE': 'audit-payment-signature' },
        }),
    });

    const authorized = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_route_audit',
        payment_required: casperPaymentRequired('12'),
      },
    });
    const decisionId = authorized.json<CasperAuthorizeResponse>().decision_id;

    const audit = await app.inject({
      method: 'GET',
      url: `/v1/casper-guard/decisions/${decisionId}/audit`,
      headers: { authorization: `Bearer ${adminKey}` },
    });

    expect(audit.statusCode).toBe(200);
    expect(audit.json<CasperAuditResponse>()).toMatchObject({
      decision: {
        decision_id: decisionId,
        org_id: orgId,
        agent_id: agentId,
        outcome: 'ALLOW',
        status: 'SIGNED',
        amount: '12',
        rail: 'casper-x402',
        signed_header_hash: 'sha256:audit-signature',
      },
      hold: { status: 'RESERVED', amount: '12' },
      reconciliation_attempts: [],
      audit_anchors: [],
    });
  });

  it('exposes decision status and reconciles settled evidence through the HTTP API', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    let anchorCalls = 0;
    attachCasperGuardSigner(
      app,
      {
        kind: 'local-testnet',
        sign: () =>
          Promise.resolve({
            signedHeaderHash: 'sha256:status-signature',
            headers: { 'PAYMENT-SIGNATURE': 'status-payment-signature' },
          }),
      },
      {
        anchorDecision: () => {
          anchorCalls += 1;
          return Promise.resolve({ txHash: 'odra_tx_status_1' });
        },
      },
    );

    const authorized = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_route_reconcile',
        payment_required: casperPaymentRequired('17'),
      },
    });
    const decisionId = authorized.json<CasperAuthorizeResponse>().decision_id;

    const before = await app.inject({
      method: 'GET',
      url: `/v1/casper-guard/decisions/${decisionId}/status`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json<CasperDecisionStatusResponse>()).toMatchObject({
      decision_id: decisionId,
      status: 'SIGNED',
      rail: 'casper-x402',
      amount: '17',
      hold: { status: 'RESERVED', amount: '17' },
      audit_anchor_count: 0,
    });

    const reconciled = await app.inject({
      method: 'POST',
      url: `/v1/casper-guard/decisions/${decisionId}/reconcile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        agent_id: agentId,
        settlement: {
          status: 'settled',
          source: 'facilitator',
          evidence: { facilitator: 'casper-x402', result: 'accepted' },
          tx_hash: 'casper_tx_1',
          deploy_hash: 'deploy_hash_1',
        },
      },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json<CasperReconcileResponse>()).toMatchObject({
      decisionId,
      status: 'SETTLED',
      settled: true,
      anchored: true,
      decision: {
        decision_id: decisionId,
        status: 'SETTLED',
        hold: { status: 'SETTLED', amount: '17' },
        settlement: { tx_hash: 'casper_tx_1', deploy_hash: 'deploy_hash_1' },
        audit_anchor_count: 1,
      },
    });
    expect(anchorCalls).toBe(1);
  });
});
