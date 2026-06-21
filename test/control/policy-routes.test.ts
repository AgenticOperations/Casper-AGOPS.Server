import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedAgent, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => { stores = await startStores(); if (stores) app = buildOracleApp(stores.pool, stores.redis); }, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

interface EffectivePolicyResponse {
  agent_id: string;
  policy_epoch: number;
  spend: {
    spend_cap: string;
    per_transaction_max: string;
  };
  allocation: {
    total_budget: string;
    per_agent_max: string;
  };
}

interface DialPolicyResponse {
  policy_id: string;
  version: number;
  policy_epoch: number;
}

interface CountRow {
  n: number;
}

describe('policy routes', () => {
  it('returns the effective policy for an agent (string money, snake_case, epoch)', async ({ skip }) => {
    if (!stores || !app) return skip();
    // seedAgent cap is a plain number (whole USDC units); 10 → 10_000000 base units
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/policy`, headers: { authorization: `Bearer ${adminKey}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<EffectivePolicyResponse>();
    expect(body.agent_id).toBe(agentId);
    expect(body.spend.spend_cap).toBe('10000000');
    expect(typeof body.policy_epoch).toBe('number');
    expect(typeof body.allocation.total_budget).toBe('string');
    expect(typeof body.spend.per_transaction_max).toBe('string');
    expect(typeof body.allocation.per_agent_max).toBe('string');
  });

  it('rejects an unauthenticated read', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/policy` });
    expect(res.statusCode).toBe(401);
  });

  it('does not leak another org\'s policy (tenant fence → 404)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const orgA = await seedAgent(stores.pool, stores.redis, 10);
    const orgB = await seedAgent(stores.pool, stores.redis, 10);
    // orgB's admin asks for orgA's agent — must be fenced, not leaked.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${orgA.agentId}/policy`,
      headers: { authorization: `Bearer ${orgB.adminKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('the dial: a spend-cap edit creates a new version, bumps the epoch, and is reflected on re-read', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const before = (await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/policy`, headers: { authorization: `Bearer ${adminKey}` } })).json<EffectivePolicyResponse>();

    const res = await app.inject({
      method: 'POST', url: `/v1/agents/${agentId}/policy`,
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { class: 'spend', rules: { spend_cap: '5000000', per_transaction_max: '5000000', service_scope: ['api.example.com'], rail_permission: ['raw-x402'], velocity_limit_per_hour: 10 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<DialPolicyResponse>();
    expect(typeof body.policy_id).toBe('string');
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(body.policy_epoch).toBeGreaterThan(before.policy_epoch);

    const after = (await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/policy`, headers: { authorization: `Bearer ${adminKey}` } })).json<EffectivePolicyResponse>();
    expect(after.spend.spend_cap).toBe('5000000');
  });

  it('rejects a malformed dial body (fail-closed 400, no partial write)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({
      method: 'POST', url: `/v1/agents/${agentId}/policy`,
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { class: 'spend', rules: { spend_cap: 'not-a-number' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects the dial for another org\'s agent (tenant fence → 404)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const orgA = await seedAgent(stores.pool, stores.redis, 10);
    const orgB = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({
      method: 'POST', url: `/v1/agents/${orgA.agentId}/policy`,
      headers: { authorization: `Bearer ${orgB.adminKey}` },
      payload: { class: 'spend', rules: { spend_cap: '5000000', per_transaction_max: '5000000', service_scope: ['api.example.com'], rail_permission: ['raw-x402'], velocity_limit_per_hour: 10 } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unknown rail scheme (fail-closed 400)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({
      method: 'POST', url: `/v1/agents/${agentId}/policy`,
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { class: 'spend', rules: { spend_cap: '5000000', per_transaction_max: '5000000', service_scope: ['api.example.com'], rail_permission: ['x402'], velocity_limit_per_hour: 10 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('the dial is re-settable: dialing the cap back up takes effect (latest version wins, not most-restrictive-ever)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10); // org cap $10
    const dial = (cap: string) => app!.inject({ method: 'POST', url: `/v1/agents/${agentId}/policy`, headers: { authorization: `Bearer ${adminKey}` }, payload: { class: 'spend', rules: { spend_cap: cap, per_transaction_max: cap, service_scope: ['api.example.com'], rail_permission: ['raw-x402'], velocity_limit_per_hour: 10 } } });
    const read = async () => (await app!.inject({ method: 'GET', url: `/v1/agents/${agentId}/policy`, headers: { authorization: `Bearer ${adminKey}` } })).json<EffectivePolicyResponse>();

    const first = await dial('5000000');          // $5
    expect((await read()).spend.spend_cap).toBe('5000000');
    const second = await dial('8000000');         // $8 (still <= org $10) — must now take effect
    expect((await read()).spend.spend_cap).toBe('8000000');
    // policy_id is stable across re-dials: the single agent-scope policy is re-versioned, not forked.
    expect(first.json<DialPolicyResponse>().policy_id).toBe(second.json<DialPolicyResponse>().policy_id);
  });

  it('rejects an unauthenticated dial (401)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({
      method: 'POST', url: `/v1/agents/${agentId}/policy`,
      payload: { class: 'spend', rules: { spend_cap: '5000000', per_transaction_max: '5000000', service_scope: ['api.example.com'], rail_permission: ['raw-x402'], velocity_limit_per_hour: 10 } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('re-dialing does not accumulate agent-scope assignment rows', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const dial = (cap: string) => app!.inject({ method: 'POST', url: `/v1/agents/${agentId}/policy`, headers: { authorization: `Bearer ${adminKey}` }, payload: { class: 'spend', rules: { spend_cap: cap, per_transaction_max: cap, service_scope: ['api.example.com'], rail_permission: ['raw-x402'], velocity_limit_per_hour: 10 } } });
    await dial('5000000');
    await dial('6000000');
    await dial('7000000');
    const { rows } = await stores.pool.query<CountRow>(
      `SELECT count(*)::int AS n FROM policy_assignments WHERE scope = 'agent' AND scope_id = $1 AND class = 'spend'`, [agentId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  // A3: GET /v1/agents/:id/reputation
  it('returns UNRATED for a freshly seeded agent with no settled jobs', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/reputation`, headers: { authorization: `Bearer ${adminKey}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rated: false, status: 'UNRATED' });
  });

  it('rejects an unauthenticated reputation read (401)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId } = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/reputation` });
    expect(res.statusCode).toBe(401);
  });

  it('does not leak another org\'s reputation (tenant fence → 404)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const orgA = await seedAgent(stores.pool, stores.redis, 10);
    const orgB = await seedAgent(stores.pool, stores.redis, 10);
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${orgA.agentId}/reputation`, headers: { authorization: `Bearer ${orgB.adminKey}` } });
    expect(res.statusCode).toBe(404);
  });
});
