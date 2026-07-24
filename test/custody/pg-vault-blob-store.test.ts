import { describe, it, expect, vi } from 'vitest';
import { createPgVaultBlobStore } from '../../src/engines/custody/pg-vault-blob-store.js';

function fakePool(row: { encrypted_private_key: string } | undefined) {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }),
  } as unknown as import('pg').Pool;
}

describe('createPgVaultBlobStore (VaultBlobStore backed by agent_vault_keys, one row per agent)', () => {
  it('get() returns the blob for the agent', async () => {
    const pool = fakePool({ encrypted_private_key: 'iv.ciphertext.tag' });
    const store = createPgVaultBlobStore(pool);
    expect(await store.get('agt_1')).toBe('iv.ciphertext.tag');
  });

  it('get() returns null when the agent has no vault row', async () => {
    const pool = fakePool(undefined);
    const store = createPgVaultBlobStore(pool);
    expect(await store.get('agt_1')).toBeNull();
  });

  it('set() upserts the blob — works whether or not a row already exists', async () => {
    const pool = fakePool(undefined);
    const store = createPgVaultBlobStore(pool);
    await store.set('agt_1', 'new-blob');

    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('INSERT INTO agent_vault_keys');
    expect(call[0]).toContain('ON CONFLICT');
    expect(call[1]).toEqual(['agt_1', 'new-blob']);
  });

  it('delete() removes the agent\'s vault row entirely', async () => {
    const pool = fakePool(undefined);
    const store = createPgVaultBlobStore(pool);
    await store.delete('agt_1');

    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('DELETE FROM agent_vault_keys');
    expect(call[1]).toEqual(['agt_1']);
  });
});
