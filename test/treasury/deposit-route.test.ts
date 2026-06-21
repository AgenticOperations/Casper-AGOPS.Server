import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedOrgAdmin, type Stores } from '../helpers/oracle-harness.js';
import { GatewayClient } from '../../src/lib/circle/gateway.js';
import { createStubTransport } from '../../src/lib/circle/stub-transport.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis, undefined, new GatewayClient(createStubTransport(stores.redis)));
}, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

describe('POST /v1/treasury/deposit (one-time, fail-closed)', () => {
  it('records the one-time deposit, rejects a repeat', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { sk } = await seedOrgAdmin(stores.pool);
    const first = await app.inject({ method: 'POST', url: '/v1/treasury/deposit', headers: { authorization: `Bearer ${sk}` }, payload: { amount: '200000000' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ available: '200000000', deposited: true });
    const second = await app.inject({ method: 'POST', url: '/v1/treasury/deposit', headers: { authorization: `Bearer ${sk}` }, payload: { amount: '200000000' } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'deposit_already_recorded' });
  });
});
