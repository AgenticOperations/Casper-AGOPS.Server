import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, seedOrgAdmin, type Stores } from '../helpers/oracle-harness.js';
import { getTreasuryBalances } from '../../src/engines/control/treasury-read.js';
import { keys } from '../../src/redis/keyspace.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

/** Insert a credited deposit-ledger row for an org on a given network. */
async function seedCreditedDeposit(
  pool: Stores['pool'],
  orgId: string,
  network: string,
  amount: string,
  deployHash: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO treasury_deposit_intents
       (org_id, ref_id, expected_amount, status, deploy_hash, credited_amount, credited_at, network)
     VALUES ($1, $2, $3, 'credited', $4, $5, now(), $6)`,
    [orgId, BigInt('0x' + deployHash.slice(0, 15)).toString(), amount, deployHash, amount, network],
  );
}

describe('getTreasuryBalances', () => {
  it('sums the org+network deposit ledger, then allocated + free as base-unit strings', async ({ skip }) => {
    if (!stores) return skip();
    const { pool, redis } = stores;
    const { orgId } = await seedOrgAdmin(pool);

    // Two credited testnet deposits for THIS org → available = 200000000.
    await seedCreditedDeposit(pool, orgId, 'casper:casper-test', '150000000', 'a'.repeat(64));
    await seedCreditedDeposit(pool, orgId, 'casper:casper-test', '50000000', 'b'.repeat(64));

    await redis.set(keys.allocationCommitted(orgId), '50000000');
    await redis.set(keys.allocationReserved(orgId), '10000000');

    const b = await getTreasuryBalances({ redis, pool }, orgId, 'casper:casper-test');
    expect(b).toEqual({
      available: '200000000',
      allocation_committed: '50000000',
      allocation_reserved: '10000000',
      allocated: '60000000',
      free: '140000000',
    });
  });

  it('is tenant- and network-isolated: another org / another network is not counted', async ({ skip }) => {
    if (!stores) return skip();
    const { pool, redis } = stores;
    const mine = await seedOrgAdmin(pool);
    const other = await seedOrgAdmin(pool);

    await seedCreditedDeposit(pool, mine.orgId, 'casper:casper-test', '100000000', 'c'.repeat(64));
    // Same-org mainnet deposit must NOT count toward the testnet balance.
    await seedCreditedDeposit(pool, mine.orgId, 'casper:casper', '999000000', 'd'.repeat(64));
    // Another org's testnet deposit must NOT leak in.
    await seedCreditedDeposit(pool, other.orgId, 'casper:casper-test', '777000000', 'e'.repeat(64));

    const b = await getTreasuryBalances({ redis, pool }, mine.orgId, 'casper:casper-test');
    expect(b.available).toBe('100000000');
  });
});
