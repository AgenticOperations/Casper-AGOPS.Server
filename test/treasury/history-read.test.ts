import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, seedAgent, type Stores } from '../helpers/oracle-harness.js';
import { recordAllocation } from '../../src/engines/ledger/events.js';
import { listTreasuryHistory, secondsSinceLastAllocation } from '../../src/engines/control/treasury-read.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('treasury history + cooldown gap', () => {
  it('returns one row per deposit/topup (agent-float credit), newest first; computes gap', async ({ skip }) => {
    if (!stores) return skip();
    const { pool, redis } = stores;
    const { orgId, agentId } = await seedAgent(pool, redis, 100);
    const t = new Date('2026-06-20T12:00:00.000Z');
    await recordAllocation(pool, { allocationId: 'alloc_h1', agentId, orgId, amount: 50_000000n, kind: 'depositFor', enforcementTimestamp: t, settlementTimestamp: t });
    const events = await listTreasuryHistory(pool, orgId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ allocation_id: 'alloc_h1', kind: 'depositFor', agent_id: agentId, amount: '50000000' });
    const gap = await secondsSinceLastAllocation(pool, agentId, Math.floor(t.getTime() / 1000) + 3600);
    expect(gap).toBe(3600);
  });
});
