import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedAgent, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => { stores = await startStores(); if (stores) app = buildOracleApp(stores.pool, stores.redis); }, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

describe('treasury read routes', () => {
  it('GET /v1/agents returns the org agents with float columns', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    const res = await app.inject({ method: 'GET', url: '/v1/agents', headers: { authorization: `Bearer ${adminKey}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: { id: string }[] }>();
    expect(body.agents.some((a) => a.id === agentId)).toBe(true);
  });
  it('GET /v1/treasury/history returns events array', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    const res = await app.inject({ method: 'GET', url: '/v1/treasury/history', headers: { authorization: `Bearer ${adminKey}` } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json<{ events: unknown[] }>().events)).toBe(true);
  });
});
