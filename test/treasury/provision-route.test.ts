import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedAgent, type Stores } from '../helpers/oracle-harness.js';
import { GatewayClient } from '../../src/lib/circle/gateway.js';
import { createStubTransport } from '../../src/lib/circle/stub-transport.js';
import { keys } from '../../src/redis/keyspace.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis, undefined, new GatewayClient(createStubTransport(stores.redis)));
}, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

describe('POST /v1/agents/:id/float (+ /topup)', () => {
  it('provisions a float (submitted) and bumps float_pending', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    const res = await app.inject({ method: 'POST', url: `/v1/agents/${agentId}/float`, headers: { authorization: `Bearer ${adminKey}` }, payload: { amount: '50000000' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'submitted', state: 'pending' });
    expect(await stores.redis.get(keys.floatPending(agentId))).toBe('50000000');
  });
  it('404 for an agent outside the admin org', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    const res = await app.inject({ method: 'POST', url: `/v1/agents/agt_not_mine/float`, headers: { authorization: `Bearer ${adminKey}` }, payload: { amount: '50000000' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'agent_not_found' });
  });
});
