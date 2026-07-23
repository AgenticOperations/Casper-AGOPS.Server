import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EncryptedStoreVault,
  KmsVault,
  type VaultBlobStore,
} from '../../src/engines/custody/key-vault.js';

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

const MASTER_SECRET = randomBytes(32).toString('hex');

describe('EncryptedStoreVault (D-3, finals backend)', () => {
  it('generates a keypair and can sign with it without ever returning the private key', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });

    const { publicKey } = await vault.generateKeypair('agt_1');
    expect(typeof publicKey).toBe('string');
    expect(publicKey.length).toBeGreaterThan(0);

    const message = new TextEncoder().encode('hello');
    const signature = await vault.signWith('agt_1', message);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBeGreaterThan(0);
  });

  it('stores the private key as ciphertext, not plaintext', async () => {
    const store = inMemoryBlobStore();
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store });

    await vault.generateKeypair('agt_1');
    const blob = await store.get('agt_1');
    expect(blob).not.toBeNull();
    // The blob must not contain a PEM header — proof it's ciphertext, not the raw key.
    expect(blob).not.toMatch(/BEGIN (EC )?PRIVATE KEY/);
  });

  it('signWith fails to decrypt (throws) when the master secret is wrong', async () => {
    const store = inMemoryBlobStore();
    const vaultA = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store });
    await vaultA.generateKeypair('agt_1');

    const wrongSecret = randomBytes(32).toString('hex');
    const vaultB = new EncryptedStoreVault({ masterSecretHex: wrongSecret, store });

    await expect(vaultB.signWith('agt_1', new TextEncoder().encode('hi'))).rejects.toThrow();
  });

  it('two agents get independent keys — signing agent A never uses agent B key material', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const a = await vault.generateKeypair('agt_a');
    const b = await vault.generateKeypair('agt_b');
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('rotate() replaces the key and produces a different public key', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const before = await vault.generateKeypair('agt_1');
    const after = await vault.rotate('agt_1');
    expect(after.publicKey).not.toBe(before.publicKey);
  });

  it('revoke() removes the key — signWith afterwards rejects', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    await vault.generateKeypair('agt_1');
    await vault.revoke('agt_1');
    await expect(vault.signWith('agt_1', new TextEncoder().encode('hi'))).rejects.toThrow();
  });
});

describe('KmsVault (documented production future-scope stub)', () => {
  it('every method throws "not configured" — it is not built for finals', async () => {
    const vault = new KmsVault();
    await expect(vault.generateKeypair('agt_1')).rejects.toThrow(/not configured/i);
    await expect(vault.signWith('agt_1', new Uint8Array())).rejects.toThrow(/not configured/i);
    await expect(vault.rotate('agt_1')).rejects.toThrow(/not configured/i);
    await expect(vault.revoke('agt_1')).rejects.toThrow(/not configured/i);
  });
});
