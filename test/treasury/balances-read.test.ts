import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';
import { getTreasuryBalances } from '../../src/engines/control/treasury-read.js';
import { keys } from '../../src/redis/keyspace.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('getTreasuryBalances', () => {
  it('returns available + allocated + free as base-unit strings', async ({ skip }) => {
    if (!stores) return skip();
    const { redis } = stores;
    let available = 0n;
    const gateway: CasperTreasuryClient = {
      getBalances: vi.fn(async () => ({ available })),
      deposit: vi.fn(async (params: { orgId: string; amount: bigint }) => {
        available += params.amount;
        return { id: 'gw_tx_1' };
      }),
      depositFor: vi.fn(),
      reclaimFor: vi.fn(),
      isFinal: vi.fn(),
    };
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
