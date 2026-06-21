import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { issueAdminKey } from '../../src/lib/ids.js';
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
 * Credential-class fence (doc 03 §9): the admin session key (`sk_live_…`) is the org-management
 * credential and is rejected on the agent hot path BEFORE any database lookup. Only the per-agent
 * `ag_live_…` bearer authorizes a payment. Requires Docker; skips when none is available.
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

describe('POST /v1/payment/authorize — sk_ admin key is fenced out of the hot path', () => {
  it('rejects an sk_live_ key with 401, never reaching enforcement', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId } = await seedAgent(stores.pool, stores.redis, 10);
    const adminKey = issueAdminKey().token; // sk_live_… — valid admin credential, wrong surface

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'admin_key_not_permitted' });
  });

  it('rejects a missing/garbage bearer with 401', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId } = await seedAgent(stores.pool, stores.redis, 10);

    const noHeader = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(noHeader.statusCode).toBe(401);

    const garbage = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: 'Bearer ag_live_deadbeef' }, // well-formed prefix, no such agent
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.json()).toEqual({ error: 'invalid_token' });
  });
});
