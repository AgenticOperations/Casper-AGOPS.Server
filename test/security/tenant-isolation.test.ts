import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startStores,
  stopStores,
  buildOracleApp,
  seedAgent,
  raw402,
  requestContext,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * Tenant isolation (doc 01 §invariants, engine-specs-FINAL.md §E9): a bearer authorizes ONLY its own
 * agent. Agent A's key naming agent B in the body is rejected (no acting-as, even within an org, and
 * across orgs), and an unknown key is rejected outright. Requires Docker; skips when none is available.
 */

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

describe('POST /v1/payment/authorize — a key authorizes only its own agent', () => {
  it("rejects agent A's key naming a different agent (cross-org) with 403", async ({ skip }) => {
    if (!stores || !app) return skip();
    const a = await seedAgent(stores.pool, stores.redis, 10); // org 1
    const b = await seedAgent(stores.pool, stores.redis, 10); // org 2, distinct agent

    // Sanity: A's key authorizing A succeeds.
    const ownAgent = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${a.apiKey}` },
      payload: { agent_id: a.agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(ownAgent.statusCode).toBe(200);

    // A's key naming B's agent_id (a different tenant) is forbidden — never reaches enforcement.
    const crossTenant = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${a.apiKey}` },
      payload: { agent_id: b.agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json()).toEqual({ error: 'tenant_mismatch' });
  });

  it('rejects a totally unknown bearer with 401', async ({ skip }) => {
    if (!stores || !app) return skip();
    const a = await seedAgent(stores.pool, stores.redis, 10);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: 'Bearer ag_live_0000000000000000000000000000000000000000000000' },
      payload: { agent_id: a.agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_token' });
  });
});
