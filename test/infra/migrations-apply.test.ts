import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Proves the M0 acceptance criterion: migrations apply cleanly to a fresh Postgres,
 * and the runner is idempotent (a second run applies nothing). Requires Docker; the
 * suite skips itself (rather than failing) when no container runtime is available.
 */
let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let dockerAvailable = true;

beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  } catch {
    dockerAvailable = false;
  }
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('schema migrations', () => {
  it('apply to a fresh database and are idempotent', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();

    const first = await runMigrations(pool);
    expect(first).toContain('0001_init');

    const second = await runMigrations(pool);
    expect(second).toHaveLength(0); // already applied -> no-op

    const ext = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','citext')",
    );
    expect(ext.rowCount).toBe(2);
  });

  it('applies 0002_control with the tenancy + policy tables and no agent key column', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool) return skip();
    await runMigrations(pool); // idempotent: ensure 0002 is applied

    const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(applied.rows.map((r) => r.id)).toContain('0002_control');

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('orgs','teams','agents','policies','policy_assignments')`,
    );
    expect(tables.rowCount).toBe(5);

    // The agent NEVER holds a private key (engine-specs-FINAL.md:276-277): the column must not exist.
    const keyCol = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'private_key'",
    );
    expect(keyCol.rowCount).toBe(0);
  });

  it('applies 0003_ledger with append-only double-entry journals and dual NOT NULL timestamps', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool) return skip();
    await runMigrations(pool); // idempotent: ensure 0003 is applied

    const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(applied.rows.map((r) => r.id)).toContain('0003_ledger');

    // The per-payment audit row + the two double-entry journals (engine-specs-FINAL.md:147,152).
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('payment_events','spend_events','allocation_events')`,
    );
    expect(tables.rowCount).toBe(3);

    // Double-entry rows are appended only once a payment has SETTLED, so BOTH timestamps are
    // NOT NULL (NFR-01 dual timestamps, engine-specs-FINAL.md:151).
    const ts = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'spend_events'
          AND column_name IN ('enforcement_timestamp','settlement_timestamp')`,
    );
    expect(ts.rowCount).toBe(2);
    expect(ts.rows.every((r) => r.is_nullable === 'NO')).toBe(true);

    // direction is constrained to the double-entry vocabulary {debit, credit}.
    const checks = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'spend_events'::regclass AND contype = 'c'`,
    );
    expect(checks.rows.some((r) => /direction/.test(r.def) && /debit/.test(r.def))).toBe(true);

    // Append-only by construction: no trigger or rule mutates the ledger tables in place.
    const triggers = await pool.query(
      `SELECT 1 FROM information_schema.triggers
        WHERE event_object_table IN ('payment_events','spend_events','allocation_events')`,
    );
    expect(triggers.rowCount).toBe(0);
  });

  it('applies 0013_network_scoping: holds default to testnet and reject unknown networks', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool) return skip();
    await runMigrations(pool); // idempotent: ensure 0013 is applied

    const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(applied.rows.map((r) => r.id)).toContain('0013_network_scoping');

    await pool.query(
      `INSERT INTO orgs (id, name, admin_key_hash) VALUES ('org_net_test', 'Network Test Org', 'hash')
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO agents (id, org_id, api_key_hash) VALUES ('agt_net_test', 'org_net_test', 'hash')
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO casper_guard_decisions
         (decision_id, idempotency_key, org_id, agent_id, action_kind, network, resource_id,
          amount, asset_kind, asset_ref, status, outcome, policy_ref, intent_json)
       VALUES
         ('cgd_net_test', 'idem_net_test', 'org_net_test', 'agt_net_test', 'casper-deploy',
          'casper:casper-test', 'res_net_test', 100, 'native', 'CSPR', 'RESERVED', 'ALLOW',
          'policy_net_test', '{}'::jsonb)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
    );

    // Insert a hold WITHOUT specifying network — must default to testnet.
    await pool.query(
      `INSERT INTO casper_guard_holds
         (hold_id, decision_id, org_id, agent_id, amount, asset_kind, asset_ref, status)
       VALUES ('hold_net_test', 'cgd_net_test', 'org_net_test', 'agt_net_test', 100, 'native', 'CSPR', 'RESERVED')
       ON CONFLICT (hold_id) DO NOTHING`,
    );
    const hold = await pool.query<{ network: string }>(
      `SELECT network FROM casper_guard_holds WHERE hold_id = 'hold_net_test'`,
    );
    expect(hold.rows[0]?.network).toBe('casper:casper-test');

    // A bogus network value must be rejected by the CHECK constraint.
    await expect(
      pool.query(
        `INSERT INTO casper_guard_holds
           (hold_id, decision_id, org_id, agent_id, amount, asset_kind, asset_ref, status, network)
         VALUES ('hold_net_bogus', 'cgd_net_test', 'org_net_test', 'agt_net_test', 100, 'native', 'CSPR', 'RESERVED', 'casper:bogus')`,
      ),
    ).rejects.toThrow();
  });

  it('applies 0014_delegated_keys: enforces a single ACTIVE key per agent', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    await runMigrations(pool); // idempotent: ensure 0014 is applied

    const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(applied.rows.map((r) => r.id)).toContain('0014_delegated_keys');

    await pool.query(
      `INSERT INTO orgs (id, name, admin_key_hash) VALUES ('org_dk_test', 'Delegated Key Test Org', 'hash')
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO agents (id, org_id, api_key_hash) VALUES ('agt_dk_test', 'org_dk_test', 'hash')
       ON CONFLICT (id) DO NOTHING`,
    );

    await pool.query(
      `INSERT INTO delegated_keys (id, agent_id, public_key) VALUES ('dk_1', 'agt_dk_test', 'pub_1')`,
    );

    // A second ACTIVE key for the same agent must violate the partial unique index.
    await expect(
      pool.query(
        `INSERT INTO delegated_keys (id, agent_id, public_key) VALUES ('dk_2', 'agt_dk_test', 'pub_2')`,
      ),
    ).rejects.toThrow();

    // Rotating (mark old ROTATED, insert new ACTIVE) leaves exactly one ACTIVE row.
    await pool.query(`UPDATE delegated_keys SET status = 'ROTATED' WHERE id = 'dk_1'`);
    await pool.query(
      `INSERT INTO delegated_keys (id, agent_id, public_key) VALUES ('dk_2', 'agt_dk_test', 'pub_2')`,
    );
    const activeAfterRotate = await pool.query(
      `SELECT id FROM delegated_keys WHERE agent_id = 'agt_dk_test' AND status = 'ACTIVE'`,
    );
    expect(activeAfterRotate.rows.map((r: { id: string }) => r.id)).toEqual(['dk_2']);

    // Revoking leaves zero ACTIVE.
    await pool.query(`UPDATE delegated_keys SET status = 'REVOKED', revoked_at = now() WHERE id = 'dk_2'`);
    const activeAfterRevoke = await pool.query(
      `SELECT id FROM delegated_keys WHERE agent_id = 'agt_dk_test' AND status = 'ACTIVE'`,
    );
    expect(activeAfterRevoke.rowCount).toBe(0);
  });
});
