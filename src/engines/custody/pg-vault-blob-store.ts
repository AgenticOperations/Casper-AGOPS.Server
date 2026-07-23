import type pg from 'pg';
import type { VaultBlobStore } from './key-vault.js';

/**
 * Postgres-backed VaultBlobStore: one row per agent in `agent_vault_keys`
 * (0015_agent_vault_keys.sql), keyed only by agent_id — deliberately decoupled from
 * delegated_keys' ACTIVE/ROTATED/REVOKED lifecycle so vault key generation has no ordering
 * dependency on a delegated_keys row existing first (see delegated-keys-store.ts for how the two
 * compose: generate the vault keypair, THEN insert the delegated_keys row with that public key).
 */
export function createPgVaultBlobStore(pool: pg.Pool): VaultBlobStore {
  return {
    async get(agentId: string): Promise<string | null> {
      const result = await pool.query<{ encrypted_private_key: string }>(
        `SELECT encrypted_private_key FROM agent_vault_keys WHERE agent_id = $1`,
        [agentId],
      );
      return result.rows[0]?.encrypted_private_key ?? null;
    },

    async set(agentId: string, blob: string): Promise<void> {
      await pool.query(
        `INSERT INTO agent_vault_keys (agent_id, encrypted_private_key)
         VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET encrypted_private_key = EXCLUDED.encrypted_private_key`,
        [agentId, blob],
      );
    },

    async delete(agentId: string): Promise<void> {
      await pool.query(`DELETE FROM agent_vault_keys WHERE agent_id = $1`, [agentId]);
    },
  };
}
