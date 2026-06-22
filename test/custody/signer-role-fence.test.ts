import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LocalKmsSigner, SignerFenceViolation } from '../../src/lib/kms/signer.js';
import { buildTransferAuthorization, type TransferAuthorization } from '../../src/lib/eip712/eip3009.js';

/**
 * Thesis claim: the blast-radius fence holds — a treasury key cannot sign an external transfer
 * and an agent-float key cannot sign an internal allocation (engine-specs-FINAL.md:202-204).
 */

const DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 5042002,
  verifyingContract: '0x3600000000000000000000000000000000000000' as Address,
};

function makeSigner(): LocalKmsSigner {
  return new LocalKmsSigner({
    'treasury-allocation': privateKeyToAccount(generatePrivateKey()),
    'agent-float': privateKeyToAccount(generatePrivateKey()),
  });
}

function message(from: Address): TransferAuthorization {
  return buildTransferAuthorization({
    domain: DOMAIN,
    from,
    to: '0x000000000000000000000000000000000000dEaD',
    value: 1n,
    validBefore: 9_999_999_999n,
  }).message;
}

describe('signer blast-radius fence (two roles, distinct authority)', () => {
  it('agent-float signs an external spend; the treasury key cannot', async () => {
    const signer = makeSigner();
    const from = await signer.addressFor('agent-float');

    await expect(
      signer.signTransfer({ role: 'agent-float', operation: 'external-spend', domain: DOMAIN, message: message(from) }),
    ).resolves.toMatch(/^0x/);

    await expect(
      signer.signTransfer({ role: 'treasury-allocation', operation: 'external-spend', domain: DOMAIN, message: message(from) }),
    ).rejects.toBeInstanceOf(SignerFenceViolation);
  });

  it('treasury signs an internal allocation; the agent-float key cannot', async () => {
    const signer = makeSigner();
    const from = await signer.addressFor('treasury-allocation');

    await expect(
      signer.signTransfer({ role: 'treasury-allocation', operation: 'internal-allocation', domain: DOMAIN, message: message(from) }),
    ).resolves.toMatch(/^0x/);

    await expect(
      signer.signTransfer({ role: 'agent-float', operation: 'internal-allocation', domain: DOMAIN, message: message(from) }),
    ).rejects.toBeInstanceOf(SignerFenceViolation);
  });
});
