import type pg from 'pg';
import type { KeyVault } from '../../custody/key-vault.js';
import { grantDelegatedKey } from './delegated-keys-store.js';

export interface GrantDelegatedKeyWithVaultDeps {
  pool: pg.Pool;
  vault: KeyVault;
  grantDelegatedKey: typeof grantDelegatedKey;
}

/**
 * Grant a new delegated key AND generate its vault-backed keypair, in the only order that works:
 * generate first (the vault owns and persists its own key material in agent_vault_keys, keyed
 * only by agent_id — no dependency on a delegated_keys row existing), THEN insert the
 * delegated_keys row with the real generated public key. This avoids the placeholder-then-update
 * dance a delegated_keys-coupled blob store would need.
 */
export async function grantDelegatedKeyWithVault(
  deps: GrantDelegatedKeyWithVaultDeps,
  input: { id: string; agentId: string },
): Promise<{ publicKey: string }> {
  const { publicKey } = await deps.vault.generateKeypair(input.agentId);
  await deps.grantDelegatedKey(deps.pool, { id: input.id, agentId: input.agentId, publicKey });
  return { publicKey };
}
