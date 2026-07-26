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

  it('signEIP712 returns a 65-byte Casper signature (1 algorithm-tag byte + 64 raw) — the shape the facilitator settle requires', async () => {
    // Regression: previously signEIP712 returned the RAW 64-byte vault signature with no algorithm
    // tag. The service endpoint accepted it, but the facilitator's on-chain settle rejected it with
    // "signature must be 65 bytes hex" (reconcile FAILED_TERMINAL). The ExactCasperScheme hex-encodes
    // this return verbatim, and the library's own signer returns the tagged 65-byte form
    // (privateKey.signAndAddAlgorithmBytes), so this signer must too.
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const { publicKey } = await vault.generateKeypair('agt_shape');
    const signer = createVaultCasperClientSigner({
      vault,
      agentId: 'agt_shape',
      publicKeyHex: publicKey,
      accountAddress: 'account-shape',
    });

    const digest = new TextEncoder().encode('settle me on-chain');
    const sig = await signer.signEIP712(digest);
    const raw = await vault.signWith('agt_shape', digest);

    expect(raw.length).toBe(64); // ed25519 raw signature
    expect(sig.length).toBe(65); // tagged
    expect(sig[0]).toBe(1); // ed25519 algorithm tag
    expect(sig.slice(1)).toEqual(raw); // remaining 64 bytes are the raw signature unchanged
    // hex-encoded (what the facilitator receives) is exactly 130 chars = 65 bytes.
    expect(Buffer.from(sig).toString('hex')).toHaveLength(130);
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
