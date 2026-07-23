import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedOrgAdmin, type Stores } from '../helpers/oracle-harness.js';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';

function fakeGateway(): CasperTreasuryClient {
  let available = 0n;
  return {
    getBalances: vi.fn(async () => ({ available })),
    deposit: vi.fn(async (params: { orgId: string; amount: bigint }) => {
      available += params.amount;
      return { id: 'gw_tx_1' };
    }),
    depositFor: vi.fn(),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(),
  };
}

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis, undefined, fakeGateway());
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
