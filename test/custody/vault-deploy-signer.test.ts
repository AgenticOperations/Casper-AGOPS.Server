import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EncryptedStoreVault, type VaultBlobStore } from '../../src/engines/custody/key-vault.js';

const hashBytes = new Uint8Array([1, 2, 3, 4]);
const fromJSONSpy = vi.fn();
const setSignatureSpy = vi.fn();
const fromHexSpy = vi.fn();
const toJSONResult = { hash: 'deadbeef', approvals: [{ signer: 'the-public-key' }] };

vi.mock('casper-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Deploy: {
      fromJSON: fromJSONSpy,
      setSignature: setSignatureSpy,
    },
    PublicKey: {
      fromHex: fromHexSpy,
    },
  };
});

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

describe('signDeployJsonWithVault (E.3 — non-custodial swap signing, delegated key not master key)', () => {
  it('signs the deploy hash with the agent vault key (not any master key) and calls Deploy.setSignature with the algorithm-tagged signature', async () => {
    const { signDeployJsonWithVault } = await import('../../src/engines/custody/vault-deploy-signer.js');
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const { publicKey } = await vault.generateKeypair('agt_trader_1');

    const parsedDeploy = { hash: { toBytes: () => hashBytes }, toJSON: () => toJSONResult };
    fromJSONSpy.mockReturnValue(parsedDeploy);
    fromHexSpy.mockReturnValue('the-parsed-public-key');

    const signedDeployJson = await signDeployJsonWithVault({
      vault,
      agentId: 'agt_trader_1',
      publicKeyHex: publicKey,
      unsignedDeployJson: '{"unsigned":true}',
    });

    expect(fromJSONSpy).toHaveBeenCalledWith({ unsigned: true });
    expect(fromHexSpy).toHaveBeenCalledWith(publicKey);

    const setSigCall = setSignatureSpy.mock.calls[0] as [unknown, Uint8Array, unknown];
    expect(setSigCall[0]).toBe(parsedDeploy);
    // First byte is the ed25519 algorithm tag (1); the rest is the raw vault signature.
    expect(setSigCall[1][0]).toBe(1);
    expect(setSigCall[1].length).toBeGreaterThan(1);
    expect(setSigCall[2]).toBe('the-parsed-public-key');

    expect(JSON.parse(signedDeployJson)).toEqual(toJSONResult);
  });

  it('never reads or requires a master/operator PEM path — only the vault + agentId + publicKeyHex', async () => {
    const { signDeployJsonWithVault } = await import('../../src/engines/custody/vault-deploy-signer.js');
    const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET, store: inMemoryBlobStore() });
    const { publicKey } = await vault.generateKeypair('agt_trader_2');
    fromJSONSpy.mockReturnValue({ hash: { toBytes: () => hashBytes }, toJSON: () => toJSONResult });
    fromHexSpy.mockReturnValue('pub');

    // The function's own input type has no pemPath field at all — this is a structural guarantee,
    // not just a runtime check. Calling it only requires vault/agentId/publicKeyHex/unsignedDeployJson.
    await expect(
      signDeployJsonWithVault({
        vault,
        agentId: 'agt_trader_2',
        publicKeyHex: publicKey,
        unsignedDeployJson: '{}',
      }),
    ).resolves.toBeTypeOf('string');
  });
});
