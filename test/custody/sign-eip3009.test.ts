import { describe, it, expect } from 'vitest';
import { verifyTypedData, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildTransferAuthorization,
  EIP3009_TYPES,
  generateNonce,
} from '../../src/lib/eip712/eip3009.js';

/**
 * Thesis claim: EIP-3009 authorizations are built with the canonical struct and signed
 * (sign only — no broadcast in this engine). CSPRNG nonce (engine-specs-FINAL.md:201).
 */

const DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 5042002,
  verifyingContract: '0x3600000000000000000000000000000000000000' as Address,
};

describe('EIP-3009 transferWithAuthorization typed data (sign only)', () => {
  it('builds the canonical struct and signs/verifies with a local key', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const to = '0x000000000000000000000000000000000000dEaD' as Address;

    const td = buildTransferAuthorization({
      domain: DOMAIN,
      from: account.address,
      to,
      value: 1_000_000n,
      validBefore: 9_999_999_999n,
    });

    expect(td.primaryType).toBe('TransferWithAuthorization');
    expect(td.message.validAfter).toBe(0n); // defaulted
    expect(td.message.nonce).toMatch(/^0x[0-9a-f]{64}$/);

    const signature = await account.signTypedData(td);
    const ok = await verifyTypedData({
      address: account.address,
      domain: td.domain,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: td.message,
      signature,
    });
    expect(ok).toBe(true);
  });

  it('generates a fresh 256-bit nonce on each call', () => {
    expect(generateNonce()).not.toBe(generateNonce());
    expect(generateNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
