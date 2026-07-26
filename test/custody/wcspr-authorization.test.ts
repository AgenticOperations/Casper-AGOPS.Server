import { describe, it, expect, vi } from 'vitest';
import { buildVaultSignedTransferAuthorization } from '../../src/engines/custody/wcspr-authorization.js';
import type { KeyVault } from '../../src/engines/custody/key-vault.js';

const AGENT_OWN = '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a';
const OPERATOR = '0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267';
const PUBKEY = '0187a3d19eab1adf9c...deadbeef'; // shape-only; not parsed by the fakes

function makeVault(rawSig: Uint8Array): KeyVault {
  return {
    signWith: vi.fn(async () => rawSig),
  } as unknown as KeyVault;
}

describe('buildVaultSignedTransferAuthorization', () => {
  it('builds a 65-byte tagged signature, account-hash Keys, U256 amount, 32-byte nonce, validity window, and args descriptor', async () => {
    const rawSig = new Uint8Array(64).fill(7);
    const vault = makeVault(rawSig);
    const hashTypedData = vi.fn(() => new Uint8Array(32).fill(9)); // deterministic digest
    const buildDomain = vi.fn((name, version, chainName, asset) => ({ name, version, chainName, asset }));

    const now = 1_000_000;
    const res = await buildVaultSignedTransferAuthorization({
      vault,
      agentId: 'agt1',
      fromAccountHash: AGENT_OWN,
      toAccountHash: OPERATOR,
      amountMotes: '500000000',
      publicKeyHex: PUBKEY,
      domainName: 'Wrapped CSPR',
      domainVersion: '1',
      assetContractHash: 'abcdef',
      chainName: 'casper-test',
      maxTimeoutSeconds: 300,
      nowSeconds: now,
      hashTypedData: hashTypedData,
      buildDomain: buildDomain as never,
      randomNonce: () => new Uint8Array(32).fill(3),
    });

    // 65-byte tagged signature: [ed25519 tag=1][64 raw]
    expect(res.signatureHex).toHaveLength(2 * 65);
    expect(res.signatureHex.slice(0, 2)).toBe('01');
    expect(res.signatureHex.slice(2)).toBe('07'.repeat(64));

    // digest was signed via the vault
    expect(vault.signWith).toHaveBeenCalledWith('agt1', new Uint8Array(32).fill(9));

    // domain built from injected fields with 0x-prefixed asset
    expect(buildDomain).toHaveBeenCalledWith('Wrapped CSPR', '1', 'casper-test', '0xabcdef');

    // validity window
    expect(res.authorization.validAfter).toBe(String(now - 600));
    expect(res.authorization.validBefore).toBe(String(now + 300));
    expect(res.authorization.nonce).toBe('03'.repeat(32)); // 32 bytes hex
    expect(res.authorization.from).toBe(AGENT_OWN);
    expect(res.authorization.to).toBe(OPERATOR);
    expect(res.authorization.value).toBe('500000000');

    // args descriptor CLTypes match the facilitator shape
    expect(res.args.from).toEqual({ kind: 'account-hash-key', rawHash: AGENT_OWN.slice(2) });
    expect(res.args.to).toEqual({ kind: 'account-hash-key', rawHash: OPERATOR.slice(2) });
    expect(res.args.amount).toEqual({ clType: 'U256', value: '500000000' });
    expect(res.args.valid_after).toEqual({ clType: 'U64', value: String(now - 600) });
    expect(res.args.valid_before).toEqual({ clType: 'U64', value: String(now + 300) });
    expect(res.args.nonce).toEqual({ kind: 'list-u8', bytesHex: '03'.repeat(32) });
    expect(res.args.public_key).toEqual({ kind: 'public-key', publicKeyHex: PUBKEY });
    expect(res.args.signature).toEqual({ kind: 'list-u8', bytesHex: '01' + '07'.repeat(64) });
  });

  it('hard-requires a 32-byte nonce (matches the library)', async () => {
    const vault = makeVault(new Uint8Array(64));
    await expect(
      buildVaultSignedTransferAuthorization({
        vault,
        agentId: 'agt1',
        fromAccountHash: AGENT_OWN,
        toAccountHash: OPERATOR,
        amountMotes: '1',
        publicKeyHex: PUBKEY,
        domainName: 'x',
        domainVersion: '1',
        assetContractHash: 'ab',
        chainName: 'casper-test',
        maxTimeoutSeconds: 300,
        hashTypedData: (() => new Uint8Array(32)),
        buildDomain: (() => ({})),
        randomNonce: () => new Uint8Array(16), // WRONG length
      }),
    ).rejects.toThrow(/32 bytes/);
  });
});
