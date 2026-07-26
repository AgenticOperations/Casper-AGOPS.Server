import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedAgent, type Stores } from '../helpers/oracle-harness.js';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';
import { keys } from '../../src/redis/keyspace.js';

function fakeGateway(): CasperTreasuryClient {
  let n = 0;
  return {
    getBalances: vi.fn(async () => ({ available: 0n })),
    deposit: vi.fn(),
    depositFor: vi.fn(async () => {
      n += 1;
      return { id: `gw_tx_${n}` };
    }),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(async () => false),
  };
}

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis, undefined, fakeGateway());
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
