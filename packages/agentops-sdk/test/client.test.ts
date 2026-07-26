import { describe, it, expect, vi } from 'vitest';
import { createAgentOpsClient } from '../src/index.js';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const res = responses[call] ?? responses[responses.length - 1]!;
    call += 1;
    return {
      status: res.status,
      ok: res.status < 400,
      json: async () => res.body,
    } as Response;
  });
}

const BASE_URL = 'https://agentops.example';

describe('createAgentOpsClient — createAgent (D-4②)', () => {
  it('POSTs /v1/agents with the sk_ bearer and returns the created agent + api_key', async () => {
    const fetchImpl = fakeFetch([
      { status: 201, body: { agent: { id: 'agt_1', name: 'Trader', org_id: 'org_1', status: 'active' }, api_key: 'ag_live_xyz' } },
    ]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'sk_live_abc', fetchImpl });

    const result = await client.createAgent({ name: 'Trader' });

    expect(result).toEqual({
      agent: { id: 'agt_1', name: 'Trader', org_id: 'org_1', status: 'active' },
      api_key: 'ag_live_xyz',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/agents`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_live_abc');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Trader' });
  });
});

describe('createAgentOpsClient — attachTradingFlow (D-4②)', () => {
  it('POSTs /v1/orgs/:orgId/trading-flows/attach with the compiled flow + role assignments', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { role_assignments: { trader: { agentId: 'agt_1', policyId: 'pol_1' } } } }]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'sk_live_abc', fetchImpl });

    const result = await client.attachTradingFlow({
      orgId: 'org_1',
      flow: { name: 'solo-swapper', version: 1, roles: [] },
      roleAssignments: { trader: 'agt_1' },
    });

    expect(result).toEqual({ role_assignments: { trader: { agentId: 'agt_1', policyId: 'pol_1' } } });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/orgs/org_1/trading-flows/attach`);
    expect(JSON.parse(init.body as string)).toEqual({
      flow: { name: 'solo-swapper', version: 1, roles: [] },
      role_assignments: { trader: 'agt_1' },
    });
  });
});

describe('createAgentOpsClient — revokeAgent (D-4②)', () => {
  it('POSTs /v1/agents/:id/revoke-delegation with the sk_ bearer', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { agent_id: 'agt_1', agent_suspended: true, aborted_decision_ids: [], committed_decision_ids: [] } },
    ]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'sk_live_abc', fetchImpl });

    const result = await client.revokeAgent({ agentId: 'agt_1' });

    expect(result.agent_suspended).toBe(true);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/agents/agt_1/revoke-delegation`);
  });
});

describe('createAgentOpsClient — getDecision (D-4②)', () => {
  it('GETs /v1/casper-guard/decisions/:id/status with the sk_ bearer', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { decision_id: 'cgd_1', outcome: 'ALLOW', status: 'SETTLED' } }]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'sk_live_abc', fetchImpl });

    const result = await client.getDecision('cgd_1');

    expect(result).toEqual({ decision_id: 'cgd_1', outcome: 'ALLOW', status: 'SETTLED' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/casper-guard/decisions/cgd_1/status`);
    expect(init.method).toBe('GET');
  });
});

describe('createAgentOpsClient — authorize sync-default, async opt-in (D-4④)', () => {
  it('sync default: authorizes an x402 payment and returns the ALLOW/DENY result directly', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { outcome: 'ALLOW', decision_id: 'cgd_1', hold_id: 'cgh_1', payment_header: { name: 'PAYMENT-SIGNATURE', value: 'sig' }, signed_header_hash: 'sha256:x' } },
    ]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'ag_live_abc', fetchImpl });

    const result = await client.authorize({
      kind: 'x402-payment',
      agentId: 'agt_1',
      idempotencyKey: 'idem_1',
      paymentRequired: { x402Version: 2, resource: { url: 'svc:x' }, accepts: [] },
    });

    expect(result).toEqual({
      mode: 'sync',
      outcome: 'ALLOW',
      decision_id: 'cgd_1',
      hold_id: 'cgh_1',
      payment_header: { name: 'PAYMENT-SIGNATURE', value: 'sig' },
      signed_header_hash: 'sha256:x',
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/casper-guard/authorize-x402`);
  });

  it('async opt-in: returns a pollable decisionId immediately instead of waiting on the full result shape', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { outcome: 'ALLOW', decision_id: 'cgd_2', hold_id: 'cgh_2' } }]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'ag_live_abc', fetchImpl });

    const result = await client.authorize(
      {
        kind: 'x402-payment',
        agentId: 'agt_1',
        idempotencyKey: 'idem_2',
        paymentRequired: { x402Version: 2, resource: { url: 'svc:x' }, accepts: [] },
      },
      { async: true },
    );

    expect(result).toEqual({ mode: 'async', decisionId: 'cgd_2' });
  });

  it('authorizes a cspr-trade / casper-deploy / evm-transfer action intent via authorize-action', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { outcome: 'ALLOW', decision_id: 'cgd_3', hold_id: 'cgh_3', signed_header_hash: 'sha256:y' } }]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'ag_live_abc', fetchImpl });

    const result = await client.authorize({
      kind: 'action',
      agentId: 'agt_1',
      idempotencyKey: 'idem_3',
      intent: { kind: 'cspr-trade', network: 'casper:casper-test', resource_id: 'cspr.trade:swap' },
    });

    expect(result).toMatchObject({ mode: 'sync', outcome: 'ALLOW', decision_id: 'cgd_3' });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/casper-guard/authorize-action`);
  });

  it('returns the DENY shape as-is (no throw) when the server denies', async () => {
    const fetchImpl = fakeFetch([{ status: 403, body: { outcome: 'DENY', decision_id: 'cgd_4', reason: 'spend_cap_exceeded' } }]);
    const client = createAgentOpsClient({ baseUrl: BASE_URL, apiKey: 'ag_live_abc', fetchImpl });

    const result = await client.authorize({
      kind: 'x402-payment',
      agentId: 'agt_1',
      idempotencyKey: 'idem_4',
      paymentRequired: { x402Version: 2, resource: { url: 'svc:x' }, accepts: [] },
    });

    expect(result).toEqual({ mode: 'sync', outcome: 'DENY', decision_id: 'cgd_4', reason: 'spend_cap_exceeded' });
  });
});
