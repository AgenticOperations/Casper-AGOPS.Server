import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { createOrg, registerAgent } from '../../src/engines/control/store.js';
import { recordSettlement, recordAllocation } from '../../src/engines/ledger/events.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { Rail } from '../../src/contracts/index.js';

/**
 * Thesis (NFR-01, engine-specs-FINAL.md:151): every ledger row carries BOTH timestamps —
 * enforcement_timestamp (the QUOTED-time used for policy math) and settlement_timestamp (the
 * on-chain SETTLED time used for accounting). On the double-entry journals both are populated on
 * every appended row, and the two instants are recorded independently.
 *
 * Requires Docker; skips when no container runtime is available.
 */

let pgc: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let dockerAvailable = true;

const RAIL: Rail = { scheme: 'circle-nano', chain: 'arc' };

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

describe('dual timestamps on every ledger row (NFR-01)', () => {
  it('populates enforcement + settlement timestamps on the audit and both spend rows', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'TsCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    const enforcedAt = new Date('2026-06-19T23:59:59Z');
    const settledAt = new Date('2026-06-20T00:00:04Z'); // distinct instant, after rollover

    await recordSettlement(pool, {
      paymentId: 'pay_ts_1',
      agentId: agent.id,
      orgId: org.id,
      rail: RAIL,
      resourceId: 'svc:embed',
      destination: '0xVendor',
      requested: 2_000_000n,
      consumed: 2_000_000n,
      policyRef: 'policy_x@v3',
      enforcementTimestamp: enforcedAt,
      settlementTimestamp: settledAt,
    });

    const audit = await pool.query<{ enforcement_timestamp: Date; settlement_timestamp: Date }>(
      'SELECT enforcement_timestamp, settlement_timestamp FROM payment_events WHERE payment_id = $1',
      ['pay_ts_1'],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.enforcement_timestamp).toBeInstanceOf(Date);
    expect(audit.rows[0]?.settlement_timestamp).toBeInstanceOf(Date);
    // The two instants are recorded independently, not collapsed to one.
    expect(audit.rows[0]?.enforcement_timestamp.toISOString()).toBe(enforcedAt.toISOString());
    expect(audit.rows[0]?.settlement_timestamp.toISOString()).toBe(settledAt.toISOString());

    const spend = await pool.query<{ enforcement_timestamp: Date; settlement_timestamp: Date }>(
      'SELECT enforcement_timestamp, settlement_timestamp FROM spend_events WHERE payment_id = $1',
      ['pay_ts_1'],
    );
    expect(spend.rowCount).toBe(2);
    expect(
      spend.rows.every(
        (r) => r.enforcement_timestamp instanceof Date && r.settlement_timestamp instanceof Date,
      ),
    ).toBe(true);
  });

  it('populates both timestamps on every allocation row', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'TsAlloc', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    await recordAllocation(pool, {
      allocationId: 'alloc_ts',
      agentId: agent.id,
      orgId: org.id,
      amount: 5_000_000n,
      kind: 'topup',
      enforcementTimestamp: new Date('2026-06-19T08:00:00Z'),
      settlementTimestamp: new Date('2026-06-19T08:00:01Z'),
    });

    const rows = await pool.query<{ enforcement_timestamp: Date; settlement_timestamp: Date }>(
      'SELECT enforcement_timestamp, settlement_timestamp FROM allocation_events WHERE allocation_id = $1',
      ['alloc_ts'],
    );
    expect(rows.rowCount).toBe(2);
    expect(
      rows.rows.every(
        (r) => r.enforcement_timestamp instanceof Date && r.settlement_timestamp instanceof Date,
      ),
    ).toBe(true);
  });
});
