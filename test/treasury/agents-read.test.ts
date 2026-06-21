import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, seedAgent, type Stores } from '../helpers/oracle-harness.js';
import { listAgentsWithFloats } from '../../src/engines/control/treasury-read.js';
import { keys } from '../../src/redis/keyspace.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('listAgentsWithFloats', () => {
  it('returns one row per org agent with float columns + spendable', async ({ skip }) => {
    if (!stores) return skip();
    const { pool, redis } = stores;
    const { orgId, agentId } = await seedAgent(pool, redis, 100);
    await redis.set(keys.floatConfirmed(agentId), '50000000');
    await redis.set(keys.consumed(agentId), '10000000');
    const rows = await listAgentsWithFloats(pool, redis, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: agentId, status: 'active',
      float_confirmed: '50000000', consumed: '10000000',
      float_pending: '0', reserved: '0', spendable: '40000000',
    });
  });
});
