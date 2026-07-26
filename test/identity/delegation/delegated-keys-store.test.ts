import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../../src/db/migrate.js';
import {
  grantDelegatedKey,
  markDelegatedKeyGranted,
  readActiveDelegatedKeyRow,
} from '../../../src/engines/identity/delegation/delegated-keys-store.js';

/**
 * Docker-gated store test for the on-chain grant-state lifecycle (Half-2):
 *   grant -> pending, markDelegatedKeyGranted -> granted, readActiveDelegatedKeyRow.
 * Requires Docker; skips (not fails) when no container runtime is available.
 */
let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let dockerAvailable = true;

beforeAll(async () => {
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
  } catch {
    dockerAvailable = false;
  }
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/** Seed an org + agent with unique hashes (admin_key_hash / api_key_hash are UNIQUE). */
async function seedAgent(p: pg.Pool, suffix: string): Promise<string> {
  const orgId = `org_dks_${suffix}`;
  const agentId = `agt_dks_${suffix}`;
  await p.query(
    `INSERT INTO orgs (id, name, admin_key_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [orgId, `Store Test Org ${suffix}`, `hash_dks_org_${suffix}`],
  );
  await p.query(
    `INSERT INTO agents (id, org_id, api_key_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [agentId, orgId, `hash_dks_agt_${suffix}`],
  );
  return agentId;
}

describe('delegated-keys-store grant-state lifecycle', () => {
  it('grantDelegatedKey inserts a row defaulting to grant_state=pending', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const agentId = await seedAgent(pool, 'pending');

    await grantDelegatedKey(pool, { id: 'dk_pending', agentId, publicKey: 'pub_pending' });

    const row = await pool.query<{ grant_state: string; grant_deploy_hash: string | null }>(
      `SELECT grant_state, grant_deploy_hash FROM delegated_keys WHERE id = 'dk_pending'`,
    );
    expect(row.rows[0]?.grant_state).toBe('pending');
    expect(row.rows[0]?.grant_deploy_hash).toBeNull();
  });

  it('markDelegatedKeyGranted flips the ACTIVE key to granted with deploy hash + timestamp', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool) return skip();
    const agentId = await seedAgent(pool, 'granted');
    await grantDelegatedKey(pool, { id: 'dk_granted', agentId, publicKey: 'pub_granted' });

    const updated = await markDelegatedKeyGranted(pool, { agentId, deployHash: 'deploy_abc' });
    expect(updated).toBe(true);

    const row = await pool.query<{
      grant_state: string;
      grant_deploy_hash: string | null;
      granted_on_chain_at: string | null;
    }>(
      `SELECT grant_state, grant_deploy_hash, granted_on_chain_at FROM delegated_keys WHERE id = 'dk_granted'`,
    );
    expect(row.rows[0]?.grant_state).toBe('granted');
    expect(row.rows[0]?.grant_deploy_hash).toBe('deploy_abc');
    expect(row.rows[0]?.granted_on_chain_at).not.toBeNull();
  });

  it('markDelegatedKeyGranted returns false when the agent has no ACTIVE key', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const agentId = await seedAgent(pool, 'noactive');

    const updated = await markDelegatedKeyGranted(pool, { agentId, deployHash: 'deploy_none' });
    expect(updated).toBe(false);
  });

  it('readActiveDelegatedKeyRow returns the ACTIVE key with its grant state', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const agentId = await seedAgent(pool, 'readrow');
    await grantDelegatedKey(pool, { id: 'dk_readrow', agentId, publicKey: 'pub_readrow' });

    const beforeGrant = await readActiveDelegatedKeyRow(pool, agentId);
    expect(beforeGrant).toEqual({
      id: 'dk_readrow',
      publicKey: 'pub_readrow',
      grantState: 'pending',
      grantDeployHash: null,
    });

    await markDelegatedKeyGranted(pool, { agentId, deployHash: 'deploy_readrow' });
    const afterGrant = await readActiveDelegatedKeyRow(pool, agentId);
    expect(afterGrant).toEqual({
      id: 'dk_readrow',
      publicKey: 'pub_readrow',
      grantState: 'granted',
      grantDeployHash: 'deploy_readrow',
    });
  });

  it('readActiveDelegatedKeyRow returns null when the agent has no ACTIVE key', async ({ skip }) => {
    if (!dockerAvailable || !pool) return skip();
    const agentId = await seedAgent(pool, 'nullrow');

    const row = await readActiveDelegatedKeyRow(pool, agentId);
    expect(row).toBeNull();
  });
});
