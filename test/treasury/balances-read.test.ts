import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import { GatewayClient } from '../../src/lib/circle/gateway.js';
import { createStubTransport } from '../../src/lib/circle/stub-transport.js';
import { getTreasuryBalances } from '../../src/engines/control/treasury-read.js';
import { keys } from '../../src/redis/keyspace.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('getTreasuryBalances', () => {
  it('returns available + allocated + free as base-unit strings', async ({ skip }) => {
    if (!stores) return skip();
    const { redis } = stores;
    const gateway = new GatewayClient(createStubTransport(redis));
    await gateway.deposit({ orgId: 'org_b', amount: 200_000000n });
    await redis.set(keys.allocationCommitted('org_b'), '50000000');
    await redis.set(keys.allocationReserved('org_b'), '10000000');
    const b = await getTreasuryBalances({ redis, gateway }, 'org_b');
    expect(b).toEqual({
      available: '200000000',
      allocation_committed: '50000000',
      allocation_reserved: '10000000',
      allocated: '60000000',
      free: '140000000',
    });
  });
});
