import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, buildOracleApp, type Stores } from '../helpers/oracle-harness.js';
import { issueAdminKey } from '../../src/lib/ids.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('demo routes (Docker-gated)', () => {
  it('POST /v1/demo/setup returns a usable agent handle (DEMO_ENABLED)', async (ctx) => {
    if (!stores) return ctx.skip();
    const app = buildOracleApp(stores.pool, stores.redis, undefined, undefined, { DEMO_ENABLED: 'true' });
    const sk = issueAdminKey().token;
    const res = await app.inject({
      method: 'POST', url: '/v1/demo/setup',
      headers: { authorization: `Bearer ${sk}` }, payload: { cap_usdc: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      agent_id: string;
      agent_key: string;
      spend_cap: string;
      authorize_template: { accept: { resource: string } };
    }>();
    expect(body.agent_id).toMatch(/^agt_/);
    expect(body.agent_key).toMatch(/^ag_live_/);
    expect(body.spend_cap).toBe('10000000');
    expect(body.authorize_template.accept.resource).toBe('svc:weather');
    await app.close();
  });

  it('POST /v1/demo/setup is 401 without an admin bearer', async (ctx) => {
    if (!stores) return ctx.skip();
    const app = buildOracleApp(stores.pool, stores.redis, undefined, undefined, { DEMO_ENABLED: 'true' });
    const res = await app.inject({ method: 'POST', url: '/v1/demo/setup', payload: { cap_usdc: 10 } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('demo routes are ABSENT (404) when DEMO_ENABLED is not true', async (ctx) => {
    if (!stores) return ctx.skip();
    const app = buildOracleApp(stores.pool, stores.redis); // default DEMO_ENABLED=false
    const sk = issueAdminKey().token;
    const res = await app.inject({ method: 'POST', url: '/v1/demo/setup', headers: { authorization: `Bearer ${sk}` }, payload: { cap_usdc: 10 } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('KILLER CELL: setup agent via route → $5 ALLOW → $12 DENY spend_cap_exceeded', async (ctx) => {
    if (!stores) return ctx.skip();
    const app = buildOracleApp(stores.pool, stores.redis, undefined, undefined, { DEMO_ENABLED: 'true' });
    const sk = issueAdminKey().token;

    // Step 1: setup via route
    const setupRes = await app.inject({
      method: 'POST', url: '/v1/demo/setup',
      headers: { authorization: `Bearer ${sk}` }, payload: { cap_usdc: 10 },
    });
    expect(setupRes.statusCode).toBe(200);
    const handle = setupRes.json<{
      agent_id: string; agent_key: string; spend_cap: string;
      authorize_template: {
        accept: { scheme: string; network: string; resource: string; payTo: string; maxTimeoutSeconds: number; asset: string };
        request_context: { method: string; url: string };
      };
    }>();

    const { agent_id: agentId, agent_key: agentKey, authorize_template: tpl } = handle;

    // Step 2: $5 charge → ALLOW (200)
    const allowRes = await app.inject({
      method: 'POST', url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${agentKey}` },
      payload: {
        agent_id: agentId,
        raw_402_body: {
          x402Version: 1,
          accepts: [{ ...tpl.accept, maxAmountRequired: '5000000' }],
        },
        request_context: tpl.request_context,
      },
    });
    expect(allowRes.statusCode).toBe(200);
    expect(allowRes.json<{ payment_id: string }>().payment_id).toMatch(/^pay_/);

    // Step 3: $12 charge → DENY spend_cap_exceeded (403)
    const denyRes = await app.inject({
      method: 'POST', url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${agentKey}` },
      payload: {
        agent_id: agentId,
        raw_402_body: {
          x402Version: 1,
          accepts: [{ ...tpl.accept, maxAmountRequired: '12000000' }],
        },
        request_context: tpl.request_context,
      },
    });
    expect(denyRes.statusCode).toBe(403);
    expect(denyRes.json()).toEqual({ error: 'spend_cap_exceeded' });

    await app.close();
  });
});
