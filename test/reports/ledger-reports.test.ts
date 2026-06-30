import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, seedAgent, type Stores } from '../helpers/oracle-harness.js';
import { recordSettlement, recordDecision } from '../../src/engines/ledger/events.js';
import { resolvePeriod, readStatement, readAuditLog } from '../../src/engines/ledger/reports.js';
import type { Rail } from '../../src/contracts/index.js';

const RAIL: Rail = { scheme: 'raw-x402', chain: 'arc' };
const ALL = resolvePeriod('all', new Date('2026-06-20T12:00:00.000Z'));

let stores: Stores | null;
let ctx: Awaited<ReturnType<typeof seedAgent>>;

beforeAll(async () => {
  stores = await startStores();
  if (stores) ctx = await seedAgent(stores.pool, stores.redis, 10);
}, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('Group C ledger reads (Docker-gated)', () => {
  it('readStatement aggregates settled spend by agent/service/rail and counts denies', async ({ skip }) => {
    if (!stores) return skip();
    const ts = new Date('2026-06-19T10:00:00.000Z');
    await recordSettlement(stores.pool, {
      paymentId: 'pay_s1', agentId: ctx.agentId, orgId: ctx.orgId, rail: RAIL, resourceId: 'svc:weather',
      destination: '0xV', requested: 5_000_000n, consumed: 5_000_000n, policyRef: 'policy_x@v1',
      enforcementTimestamp: ts, settlementTimestamp: ts,
    });
    await recordSettlement(stores.pool, {
      paymentId: 'pay_s2', agentId: ctx.agentId, orgId: ctx.orgId, rail: RAIL, resourceId: 'svc:weather',
      destination: '0xV', requested: 3_000_000n, consumed: 3_000_000n, policyRef: 'policy_x@v1',
      enforcementTimestamp: ts, settlementTimestamp: ts,
    });
    await recordDecision(stores.pool, {
      paymentId: 'pay_d1', agentId: ctx.agentId, orgId: ctx.orgId, rail: RAIL, resourceId: 'svc:weather',
      requested: 9_000_000n, policyRef: 'policy_x@v1', state: 'QUOTED', result: 'DENY',
      reasonCode: 'spend_cap_exceeded', enforcementTimestamp: ts,
    });

    const s = await readStatement(stores.pool, ctx.orgId, ALL);
    expect(s.totals.settled_count).toBe(2);
    expect(s.totals.settled_amount).toBe('8000000');
    expect(s.totals.denied_count).toBe(1);
    expect(s.totals.audit_count).toBe(3); // 2 settled + 1 denied, all in window
    expect(typeof s.totals.settled_count).toBe('number'); // counts are numbers (::int)
    expect(typeof s.totals.settled_amount).toBe('string'); // money is a string (::text)
    const agentLine = s.lines.find((r) => r.agent_id === ctx.agentId);
    expect(agentLine?.amount).toBe('8000000');
    const svcLine = s.lines.find((r) => r.resource_id === 'svc:weather');
    expect(svcLine?.amount).toBe('8000000');
    expect(s.lines[0]).toMatchObject({ rail_scheme: 'raw-x402', rail_chain: 'arc', amount: '8000000' });
  });

  it('readAuditLog returns immutable rows oldest-first, money strings, nullable settlement, LIMIT, org-fenced', async ({ skip }) => {
    if (!stores) return skip();
    // Distinct enforcement times so ASC ordering is meaningfully tested (not just a payment_id tiebreak).
    await recordSettlement(stores.pool, {
      paymentId: 'pay_early', agentId: ctx.agentId, orgId: ctx.orgId, rail: RAIL, resourceId: 'svc:weather',
      destination: '0xV', requested: 1_000_000n, consumed: 1_000_000n, policyRef: 'policy_x@v1',
      enforcementTimestamp: new Date('2026-06-19T09:00:00.000Z'), settlementTimestamp: new Date('2026-06-19T09:30:00.000Z'),
    });
    await recordSettlement(stores.pool, {
      paymentId: 'pay_late', agentId: ctx.agentId, orgId: ctx.orgId, rail: RAIL, resourceId: 'svc:weather',
      destination: '0xV', requested: 2_000_000n, consumed: 2_000_000n, policyRef: 'policy_x@v1',
      enforcementTimestamp: new Date('2026-06-19T11:00:00.000Z'), settlementTimestamp: new Date('2026-06-19T11:30:00.000Z'),
    });

    const other = await seedAgent(stores.pool, stores.redis, 10);
    const rows = await readAuditLog(stores.pool, ctx.orgId, ALL, 500);

    // Org-fence: only this org's rows; a different org sees none.
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((r) => r.agent_id === ctx.agentId)).toBe(true);
    expect(await readAuditLog(stores.pool, other.orgId, ALL, 500)).toHaveLength(0);

    // Oldest-first: enforcement timestamps are non-decreasing (ISO sorts chronologically); earliest row leads.
    const times = rows.map((r) => r.enforcement_timestamp);
    expect(times).toEqual([...times].sort());
    expect(rows[0]!.payment_id).toBe('pay_early');

    // Money is a string; settlement_timestamp is a nullable ISO string (settled -> ISO, denied -> null).
    expect(typeof rows[0]!.consumed).toBe('string');
    expect(typeof rows.find((r) => r.payment_id === 'pay_early')!.settlement_timestamp).toBe('string');
    expect(rows.find((r) => r.payment_id === 'pay_d1')!.settlement_timestamp).toBeNull();

    // LIMIT is applied.
    expect(await readAuditLog(stores.pool, ctx.orgId, ALL, 2)).toHaveLength(2);
  });
});
