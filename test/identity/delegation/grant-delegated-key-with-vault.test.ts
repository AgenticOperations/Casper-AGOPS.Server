import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EncryptedStoreVault, type VaultBlobStore } from '../../../src/engines/custody/key-vault.js';
import { grantDelegatedKeyWithVault } from '../../../src/engines/identity/delegation/grant-delegated-key-with-vault.js';

const MASTER_SECRET = randomBytes(32).toString('hex');

function inMemoryBlobStore(): VaultBlobStore {
  const map = new Map<string, string>();
  return {
    async get(agentId) {
      return map.get(agentId) ?? null;
    },
    async set(agentId, blob) {
      map.set(agentId, blob);
    },
    async delete(agentId) {
      map.delete(agentId);
    },
  };
}

describe('grantDelegatedKeyWithVault (composes vault key generation + delegated_keys insert)', () => {
  it('generates the vault keypair first, then inserts delegated_keys with that real public key', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const grantDelegatedKey = vi.fn().mockResolvedValue(undefined);
    const pool = {} as unknown as import('pg').Pool;

    const result = await grantDelegatedKeyWithVault(
      { pool, vault, grantDelegatedKey },
      { id: 'dk_1', agentId: 'agt_1' },
    );

    expect(result.publicKey).toMatch(/^[0-9a-f]+$/i);
    expect(grantDelegatedKey).toHaveBeenCalledWith(pool, {
      id: 'dk_1',
      agentId: 'agt_1',
      publicKey: result.publicKey,
    });

    // The vault must actually be able to sign with the key it just generated — proves generation
    // happened for real, not just returned an arbitrary string.
    const sig = await vault.signWith('agt_1', new TextEncoder().encode('test'));
    expect(sig.length).toBeGreaterThan(0);
  });
});
