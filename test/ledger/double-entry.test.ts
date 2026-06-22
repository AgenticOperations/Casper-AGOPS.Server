import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { createOrg, registerAgent } from '../../src/engines/control/store.js';
import { recordSettlement, recordAllocation } from '../../src/engines/ledger/events.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { Rail } from '../../src/contracts/index.js';

/**
 * Thesis (engine-specs-FINAL.md:165-166): the cold tier is double-entry — every settlement appends
 * two balanced rows (one debit, one credit) that sum to zero. The same holds for an allocation.
 *
 * Requires Docker; skips when no container runtime is available.
 */

let pgc: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let dockerAvailable = true;

const RAIL: Rail = { scheme: 'raw-x402', chain: 'arc' };

beforeAll(async () => {
  try {
    pgc = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new pg.Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations(pool);
  } catch {
    dockerAvailable = false;
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await pgc?.stop();
});

function balanced(rows: Array<{ direction: string; amount: string }>): {
  debit: bigint;
  credit: bigint;
} {
  let debit = 0n;
  let credit = 0n;
  for (const r of rows) {
    if (r.direction === 'debit') debit += BigInt(r.amount);
    else if (r.direction === 'credit') credit += BigInt(r.amount);
  }
  return { debit, credit };
}

describe('cold-tier double-entry (engine-specs-FINAL.md:165-166)', () => {
  it('a settlement appends two balanced spend_events rows', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'LedgerCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    await recordSettlement(pool, {
      paymentId: 'pay_de_1',
      agentId: agent.id,
      orgId: org.id,
      rail: RAIL,
      resourceId: 'svc:summarize',
      destination: '0xVendor',
      requested: 7_000_000n,
      consumed: 7_000_000n,
      policyRef: 'policy_abc@v1',
      enforcementTimestamp: new Date('2026-06-19T10:00:00Z'),
      settlementTimestamp: new Date('2026-06-19T10:00:03Z'),
    });

    const rows = await pool.query<{ direction: string; amount: string }>(
      'SELECT direction, amount FROM spend_events WHERE payment_id = $1',
      ['pay_de_1'],
    );
    expect(rows.rowCount).toBe(2);
    const { debit, credit } = balanced(rows.rows);
    expect(debit).toBe(credit); // balanced
    expect(debit).toBe(7_000_000n);

    // Exactly one audit row per payment.
    const audit = await pool.query('SELECT state, result FROM payment_events WHERE payment_id = $1', [
      'pay_de_1',
    ]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({ state: 'SETTLED', result: 'ALLOW' });
  });

  it('an allocation appends two balanced allocation_events rows', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'AllocCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    await recordAllocation(pool, {
      allocationId: 'alloc_1',
      agentId: agent.id,
      orgId: org.id,
      amount: 10_000_000n,
      kind: 'depositFor',
      enforcementTimestamp: new Date('2026-06-19T09:00:00Z'),
      settlementTimestamp: new Date('2026-06-19T09:00:02Z'),
    });

    const rows = await pool.query<{ direction: string; amount: string }>(
      'SELECT direction, amount FROM allocation_events WHERE allocation_id = $1',
      ['alloc_1'],
    );
    expect(rows.rowCount).toBe(2);
    const { debit, credit } = balanced(rows.rows);
    expect(debit).toBe(credit);
    expect(debit).toBe(10_000_000n);
  });
});
