import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CasperGuardSigner } from '../../src/engines/casper-guard/policy.js';
import { seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import { buildOracleApp } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

function testnetSigner(): CasperGuardSigner {
  return {
    kind: 'local-testnet',
    sign: () =>
      Promise.resolve({
        signedHeaderHash: 'sha256:testnet-signature',
        headers: { 'PAYMENT-SIGNATURE': 'testnet-payment-signature' },
      }),
  };
}

function mainnetSigner(): CasperGuardSigner {
  return {
    kind: 'local-testnet',
    sign: () =>
      Promise.resolve({
        signedHeaderHash: 'sha256:mainnet-signature',
        headers: { 'PAYMENT-SIGNATURE': 'mainnet-payment-signature' },
      }),
  };
}

function attachByNetworkDeps(
  app: FastifyInstance,
  input: { includeMainnet: boolean },
): void {
  (app.deps as typeof app.deps & { casperGuard: unknown }).casperGuard = {
    networks: input.includeMainnet
      ? ['casper:casper-test', 'casper:casper']
      : ['casper:casper-test'],
    mcpUrl: '/v1/casper-guard/mcp',
    trade: { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] },
    byNetwork: {
      'casper:casper-test': {
        signer: testnetSigner(),
        liveSettlement: { configured: false, reason: 'casper_facilitator_not_configured' },
        odra: { configured: false, reason: 'odra_contract_not_bound' },
      },
      ...(input.includeMainnet
        ? {
            'casper:casper': {
              signer: mainnetSigner(),
              liveSettlement: { configured: false, reason: 'casper_facilitator_not_configured' },
              odra: { configured: false, reason: 'odra_contract_not_bound' },
            },
          }
        : {}),
    },
  };
}

function casperPaymentRequired(network: string, amount = '10') {
  return {
    x402Version: 2,
    resource: { url: 'svc:casper-paid-api', serviceName: 'Casper Paid API' },
    accepts: [
      {
        scheme: 'exact',
        network,
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
}) {
  const res = await input.app.inject({
    method: 'POST',
    url: `/v1/agents/${input.agentId}/policy`,
    headers: { authorization: `Bearer ${input.adminKey}` },
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

describe('AgentOps network-scoped routes', () => {
  it('authorizes on mainnet when the header is set and mainnet is configured', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    attachByNetworkDeps(app, { includeMainnet: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}`, 'x-agentops-network': 'casper:casper' },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_network_mainnet_allow',
        payment_required: casperPaymentRequired('casper:casper'),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ payment_header: { value: string }; audit: { network: string } }>();
    expect(body.payment_header.value).toBe('mainnet-payment-signature');
    expect(body.audit.network).toBe('casper:casper');
  });

  it('503s with network_not_configured when mainnet header is set but mainnet is not configured', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    attachByNetworkDeps(app, { includeMainnet: false });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}`, 'x-agentops-network': 'casper:casper' },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_network_mainnet_unconfigured',
        payment_required: casperPaymentRequired('casper:casper'),
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'network_not_configured' });
  });

  it('400s with invalid_network for an unknown header value', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    attachByNetworkDeps(app, { includeMainnet: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}`, 'x-agentops-network': 'casper:bogus' },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_network_invalid',
        payment_required: casperPaymentRequired('casper:casper-test'),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_network' });
  });

  it('behaves exactly as testnet when no network header is sent', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    await dialCasperPolicy({ app, agentId, adminKey });
    attachByNetworkDeps(app, { includeMainnet: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/casper-guard/authorize-x402',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        agent_id: agentId,
        idempotency_key: 'idem_network_default_testnet',
        payment_required: casperPaymentRequired('casper:casper-test'),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ payment_header: { value: string }; audit: { network: string } }>();
    expect(body.payment_header.value).toBe('testnet-payment-signature');
    expect(body.audit.network).toBe('casper:casper-test');
  });
});
