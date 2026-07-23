import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EncryptedStoreVault, type VaultBlobStore } from '../../src/engines/custody/key-vault.js';
import { createVaultCasperClientSigner, resolveAgentCasperSigner } from '../../src/engines/custody/vault-signer.js';
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

const MASTER_SECRET = randomBytes(32).toString('hex');

describe('createVaultCasperClientSigner (B.4 — per-agent delegated signer)', () => {
  it('signs with agent A key and agent B key independently — no cross-agent key use', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const a = await vault.generateKeypair('agt_a');
    const b = await vault.generateKeypair('agt_b');

    const signerA = createVaultCasperClientSigner({
      vault,
      agentId: 'agt_a',
      publicKeyHex: a.publicKey,
      accountAddress: 'account-a',
    });
    const signerB = createVaultCasperClientSigner({
      vault,
      agentId: 'agt_b',
      publicKeyHex: b.publicKey,
      accountAddress: 'account-b',
    });

    expect(signerA.publicKey()).toBe(a.publicKey);
    expect(signerB.publicKey()).toBe(b.publicKey);
    expect(signerA.accountAddress()).not.toBe(signerB.accountAddress());

    const digest = new TextEncoder().encode('authorize this');
    const sigA = await signerA.signEIP712(digest);
    const sigB = await signerB.signEIP712(digest);
    expect(sigA).not.toEqual(sigB);
  });
});

describe('resolveAgentCasperSigner (B.4 — delegated key with custodial PEM fallback)', () => {
  it('uses the vault-backed delegated signer when the agent has an active delegated key', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const { publicKey } = await vault.generateKeypair('agt_1');
    const fallbackProvider = { getClientSigner: vi.fn() };

    const signer = await resolveAgentCasperSigner({
      vault,
      agentId: 'agt_1',
      delegatedPublicKeyHex: publicKey,
      network: 'casper:casper-test',
      fallbackProvider,
    });

    expect(signer.publicKey()).toBe(publicKey);
    expect(fallbackProvider.getClientSigner).not.toHaveBeenCalled();
  });

  it('falls back to the existing custodial PEM provider when the agent has no delegated key (testnet demo, D-1)', async () => {
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const fallbackSigner = { accountAddress: () => 'fallback', publicKey: () => 'fallback-pub', signEIP712: async () => new Uint8Array() } as CasperClientSigner;
    const fallbackProvider = { getClientSigner: vi.fn().mockResolvedValue(fallbackSigner) };

    const signer = await resolveAgentCasperSigner({
      vault,
      agentId: 'agt_no_delegation',
      delegatedPublicKeyHex: undefined,
      network: 'casper:casper-test',
      fallbackProvider,
    });

    expect(signer).toBe(fallbackSigner);
    expect(fallbackProvider.getClientSigner).toHaveBeenCalledWith({ network: 'casper:casper-test' });
  });
});
