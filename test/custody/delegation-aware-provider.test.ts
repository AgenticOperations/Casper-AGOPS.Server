import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EncryptedStoreVault, type VaultBlobStore } from '../../src/engines/custody/key-vault.js';
import { createDelegationAwareSignerProvider } from '../../src/engines/custody/vault-signer.js';
import type { CasperClientSigner } from '../../src/lib/casper/x402.js';

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

function fakePoolWithActiveKey(publicKey: string | null) {
  return {
    query: vi.fn().mockResolvedValue({ rows: publicKey ? [{ id: 'dk_1', public_key: publicKey }] : [] }),
  } as unknown as import('pg').Pool;
}

const MASTER_SECRET = randomBytes(32).toString('hex');

describe('createDelegationAwareSignerProvider (B.4 — the getClientSigner seam, agentId-aware)', () => {
  it('signs with the vault-backed delegated key when the agent has one ACTIVE', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const { publicKey } = await vault.generateKeypair('agt_1');
    const pool = fakePoolWithActiveKey(publicKey);
    const fallbackProvider = { mode: 'local-testnet' as const, getClientSigner: vi.fn() };

    const provider = createDelegationAwareSignerProvider({ pool, vault, fallbackProvider });
    const signer = await provider.getClientSigner({ network: 'casper:casper-test', agentId: 'agt_1' });

    expect(signer.publicKey()).toBe(publicKey);
    expect(fallbackProvider.getClientSigner).not.toHaveBeenCalled();
  });

  it('falls back to the custodial provider when the agent has no delegated key', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const pool = fakePoolWithActiveKey(null);
    const fallbackSigner = {
      accountAddress: () => 'fallback',
      publicKey: () => 'fallback-pub',
      signEIP712: async () => new Uint8Array(),
    } as CasperClientSigner;
    const fallbackProvider = { mode: 'local-testnet' as const, getClientSigner: vi.fn().mockResolvedValue(fallbackSigner) };

    const provider = createDelegationAwareSignerProvider({ pool, vault, fallbackProvider });
    const signer = await provider.getClientSigner({ network: 'casper:casper-test', agentId: 'agt_no_delegation' });

    expect(signer).toBe(fallbackSigner);
    expect(fallbackProvider.getClientSigner).toHaveBeenCalledWith({ network: 'casper:casper-test' });
  });

  it('falls back to the custodial provider when no agentId is given at all (legacy call sites)', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const pool = fakePoolWithActiveKey('should-not-be-used');
    const fallbackSigner = {
      accountAddress: () => 'fallback',
      publicKey: () => 'fallback-pub',
      signEIP712: async () => new Uint8Array(),
    } as CasperClientSigner;
    const fallbackProvider = { mode: 'local-testnet' as const, getClientSigner: vi.fn().mockResolvedValue(fallbackSigner) };

    const provider = createDelegationAwareSignerProvider({ pool, vault, fallbackProvider });
    const signer = await provider.getClientSigner({ network: 'casper:casper-test' });

    expect(signer).toBe(fallbackSigner);
  });
});
