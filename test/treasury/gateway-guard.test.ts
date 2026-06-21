import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedOrgAdmin, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => { stores = await startStores(); if (stores) app = buildOracleApp(stores.pool, stores.redis); }, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

describe('treasury routes gateway guard + auth', () => {
  it('503 when no gateway is wired into AppDeps', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { sk } = await seedOrgAdmin(stores.pool);
    const res = await app.inject({ method: 'GET', url: '/v1/treasury/balances', headers: { authorization: `Bearer ${sk}` } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'gateway_unavailable' });
  });
  it('401 when admin key missing', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({ method: 'GET', url: '/v1/treasury/balances' });
    expect(res.statusCode).toBe(401);
  });
});
