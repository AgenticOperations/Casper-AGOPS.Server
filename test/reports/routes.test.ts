import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedAgent, type Stores } from '../helpers/oracle-harness.js';
import { recordSettlement } from '../../src/engines/ledger/events.js';
import type { Rail } from '../../src/contracts/index.js';

const RAIL: Rail = { scheme: 'raw-x402', chain: 'arc' };
let stores: Stores | null;
let app: FastifyInstance | undefined;
let ctx: Awaited<ReturnType<typeof seedAgent>>;

beforeAll(async () => {
  stores = await startStores();
  if (!stores) return;
  app = buildOracleApp(stores.pool, stores.redis);
  ctx = await seedAgent(stores.pool, stores.redis, 10);
  const ts = new Date();
  await recordSettlement(stores.pool, {
    paymentId: 'pay_rt1', agentId: ctx.agentId, orgId: ctx.orgId, rail: RAIL, resourceId: 'svc:weather',
    destination: '0xV', requested: 2_000_000n, consumed: 2_000_000n, policyRef: 'policy_x@v1',
    enforcementTimestamp: ts, settlementTimestamp: ts,
  });
}, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

describe('Group C reports routes', () => {
  it('GET /v1/reports/statement requires the sk_ admin key', async ({ skip }) => {
    if (!stores || !app) return skip();
    expect((await app.inject({ method: 'GET', url: '/v1/reports/statement' })).statusCode).toBe(401);
  });

  it('GET /v1/reports/statement returns settled aggregates for the org', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'GET', url: '/v1/reports/statement?period=all',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ statement: { totals: { settled_amount: string }; period: { label: string } } }>();
    expect(body.statement.period.label).toBe('all');
    expect(BigInt(body.statement.totals.settled_amount)).toBeGreaterThanOrEqual(2_000_000n);
  });

  it('GET /v1/reports/audit-log returns immutable rows + count', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'GET', url: '/v1/reports/audit-log?period=all&limit=10',
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ rows: Array<{ payment_id: string }>; count: number }>();
    expect(body.count).toBe(body.rows.length);
    expect(body.rows.some((r) => r.payment_id === 'pay_rt1')).toBe(true);
  });
});
