import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';
import { createOrg, registerAgent } from '../../src/engines/control/store.js';
import { recordAllocation } from '../../src/engines/ledger/events.js';
import { issueAdminKey } from '../../src/lib/ids.js';

/**
 * recordAllocation persists the on-chain WCSPR funding tx hash (delegated-key agents) into
 * allocation_events.fund_tx_hash, so the treasury float-movement history can render an explorer link.
 * A funding-less allocation (no delegated key) stores NULL and shows no link.
 *
 * Requires Docker; skips when no container runtime is available.
 */
let pgc: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let dockerAvailable = true;

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

describe('allocation_events.fund_tx_hash', () => {
  it('persists the fund tx hash on both event rows when supplied', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'FundTxCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    await recordAllocation(pool, {
      allocationId: 'alloc_fundtx_1',
      agentId: agent.id,
      orgId: org.id,
      amount: 4_000_000_000n,
      kind: 'depositFor',
      enforcementTimestamp: new Date('2026-07-26T10:00:00Z'),
      settlementTimestamp: new Date('2026-07-26T10:00:03Z'),
      fundTxHash: '5d4ca4fc4b6e126bb2a9c065a7d9312056ad9e701fc7addd26ff7a355258cf38',
    });

    const rows = await pool.query<{ fund_tx_hash: string | null }>(
      'SELECT fund_tx_hash FROM allocation_events WHERE allocation_id = $1',
      ['alloc_fundtx_1'],
    );
    expect(rows.rowCount).toBe(2);
    for (const r of rows.rows) {
      expect(r.fund_tx_hash).toBe('5d4ca4fc4b6e126bb2a9c065a7d9312056ad9e701fc7addd26ff7a355258cf38');
    }
  });

  it('stores NULL when no fund tx hash is supplied (funding-less allocation)', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const org = await createOrg(pool, { name: 'NoFundTxCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    await recordAllocation(pool, {
      allocationId: 'alloc_fundtx_2',
      agentId: agent.id,
      orgId: org.id,
      amount: 1_000_000_000n,
      kind: 'depositFor',
      enforcementTimestamp: new Date('2026-07-26T10:00:00Z'),
      settlementTimestamp: new Date('2026-07-26T10:00:03Z'),
    });

    const rows = await pool.query<{ fund_tx_hash: string | null }>(
      'SELECT fund_tx_hash FROM allocation_events WHERE allocation_id = $1',
      ['alloc_fundtx_2'],
    );
    expect(rows.rowCount).toBe(2);
    for (const r of rows.rows) expect(r.fund_tx_hash).toBeNull();
  });
});
