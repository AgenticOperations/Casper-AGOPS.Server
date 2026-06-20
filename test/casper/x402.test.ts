import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  CASPER_X402_HEADER_NAME,
  CASPER_X402_TESTNET_NETWORK,
  CASPER_X402_VERSION,
  CasperX402ValidationError,
  createCasperX402PaymentHeader,
  decodeCasperX402PaymentHeader,
  getCasperX402NetworkConfig,
  verifyCasperX402Payment,
  type CasperClientSigner,
  type CasperFacilitatorSigner,
  type CasperX402PaymentRequirements,
} from '../../src/lib/casper/x402.js';
import { CasperSignerProvider, CasperSignerProviderError } from '../../src/lib/casper/signer.js';

const CEP18_PACKAGE_HASH = 'a'.repeat(64);
const require = createRequire(import.meta.url);
const casperSdk = require('casper-js-sdk') as {
  KeyAlgorithm: { ED25519: unknown };
  PrivateKey: { generate(algorithm: unknown): unknown };
};

function generatedLocalProvider(): CasperSignerProvider {
  return CasperSignerProvider.localTestnet({
    privateKey: casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519),
  });
}

function verificationOnlyFacilitatorSigner(signer: CasperClientSigner): CasperFacilitatorSigner {
  return {
    getNetworkConfig: (network) => Promise.resolve(getCasperX402NetworkConfig(network)),
    getAddresses() {
      return [signer.accountAddress()];
    },
    getPublicKeyHex() {
      return signer.publicKey();
    },
    signTransaction: () => Promise.reject(new Error('settlement signing is not used during local verification')),
    putTransaction: () => Promise.reject(new Error('settlement submission is not used during local verification')),
    waitForTransaction: () => Promise.reject(new Error('settlement waiting is not used during local verification')),
  };
}

function paymentRequired(requirements: CasperX402PaymentRequirements) {
  return {
    x402Version: CASPER_X402_VERSION,
    resource: {
      url: 'https://paid.example/casper',
      serviceName: 'CasperGuard',
    },
    accepts: [requirements],
  };
}

describe('Casper x402 wrapper', () => {
  it('creates a real PAYMENT-SIGNATURE header that the Casper package facilitator verifies', async () => {
    const provider = generatedLocalProvider();
    const signer = await provider.getClientSigner({ network: CASPER_X402_TESTNET_NETWORK });
    const requirements = {
      scheme: 'exact',
      network: CASPER_X402_TESTNET_NETWORK,
      amount: '1',
      asset: CEP18_PACKAGE_HASH,
      payTo: signer.accountAddress(),
      maxTimeoutSeconds: 900,
      extra: { name: 'Test CEP18', version: '1' },
    } satisfies CasperX402PaymentRequirements;

    const signed = await createCasperX402PaymentHeader({
      signer,
      paymentRequired: paymentRequired(requirements),
    });

    expect(signed.headerName).toBe(CASPER_X402_HEADER_NAME);
    expect(Object.keys(signed.headers)).toEqual([CASPER_X402_HEADER_NAME]);
    expect(signed.payload.x402Version).toBe(CASPER_X402_VERSION);
    expect(signed.payload.accepted.network).toBe('casper:casper-test');
    expect(signed.payload.accepted.asset).toBe(CEP18_PACKAGE_HASH);
    expect(signed.payload.payload.signature).toEqual(expect.any(String));

    const decoded = decodeCasperX402PaymentHeader(signed.headerValue);
    expect(decoded).toEqual(signed.payload);

    const verification = await verifyCasperX402Payment({
      paymentPayload: decoded,
      requirements,
      facilitatorSigner: verificationOnlyFacilitatorSigner(signer),
    });

    expect(verification.isValid).toBe(true);
  });

  it('rejects invalid Casper requirements before signing', async () => {
    const provider = generatedLocalProvider();
    const signer = await provider.getClientSigner({ network: CASPER_X402_TESTNET_NETWORK });
    let signCalls = 0;
    const countingSigner: CasperClientSigner = {
      accountAddress: () => signer.accountAddress(),
      publicKey: () => signer.publicKey(),
      async signEIP712(digest) {
        signCalls += 1;
        return signer.signEIP712(digest);
      },
    };
    const base = {
      scheme: 'exact',
      network: CASPER_X402_TESTNET_NETWORK,
      amount: '1',
      asset: CEP18_PACKAGE_HASH,
      payTo: signer.accountAddress(),
      maxTimeoutSeconds: 900,
      extra: { name: 'Test CEP18', version: '1' },
    } satisfies CasperX402PaymentRequirements;

    const invalidRequirements: Array<[string, CasperX402PaymentRequirements]> = [
      ['wrong network', { ...base, network: 'casper:casper' }],
      ['bad CEP-18 asset hash', { ...base, asset: 'not-a-package-hash' }],
      ['missing token metadata', { ...base, extra: { name: 'Test CEP18' } }],
      ['bad pay-to account', { ...base, payTo: 'not-a-casper-account' }],
      ['non-positive amount', { ...base, amount: '0' }],
    ];

    for (const [_label, requirements] of invalidRequirements) {
      await expect(
        createCasperX402PaymentHeader({
          signer: countingSigner,
          paymentRequired: paymentRequired(requirements),
        }),
      ).rejects.toBeInstanceOf(CasperX402ValidationError);
    }

    await expect(
      createCasperX402PaymentHeader({
        signer: countingSigner,
        paymentRequired: {
          ...paymentRequired(base),
          x402Version: 1,
        },
      }),
    ).rejects.toBeInstanceOf(CasperX402ValidationError);

    expect(signCalls).toBe(0);
  });

  it('turns malformed untrusted payment requirements into validation errors, not TypeErrors', async () => {
    const provider = generatedLocalProvider();
    const signer = await provider.getClientSigner({ network: CASPER_X402_TESTNET_NETWORK });
    const malformedCases: unknown[] = [
      { x402Version: CASPER_X402_VERSION },
      { x402Version: CASPER_X402_VERSION, accepts: null },
      {
        x402Version: CASPER_X402_VERSION,
        accepts: [
          {
            scheme: 'exact',
            network: CASPER_X402_TESTNET_NETWORK,
            amount: '1',
            asset: CEP18_PACKAGE_HASH,
            payTo: signer.accountAddress(),
            maxTimeoutSeconds: 900,
            extra: null,
          },
        ],
      },
    ];

    for (const malformed of malformedCases) {
      await expect(
        createCasperX402PaymentHeader({
          signer,
          paymentRequired: malformed as Parameters<typeof createCasperX402PaymentHeader>[0]['paymentRequired'],
        }),
      ).rejects.toBeInstanceOf(CasperX402ValidationError);
    }
  });

  it('fails closed with typed signer errors for unavailable signer modes', async () => {
    await expect(
      generatedLocalProvider().getClientSigner({ network: 'casper:casper' }),
    ).rejects.toMatchObject({
      code: 'CASPER_SIGNER_NETWORK_NOT_ALLOWED',
    } satisfies Partial<CasperSignerProviderError>);

    await expect(
      CasperSignerProvider.localTestnet({}).getClientSigner({ network: CASPER_X402_TESTNET_NETWORK }),
    ).rejects.toMatchObject({
      code: 'CASPER_SIGNER_UNAVAILABLE',
    } satisfies Partial<CasperSignerProviderError>);

    await expect(
      CasperSignerProvider.operatorWalletPending().getClientSigner({
        network: CASPER_X402_TESTNET_NETWORK,
      }),
    ).rejects.toMatchObject({
      code: 'CASPER_SIGNER_PENDING_APPROVAL',
    } satisfies Partial<CasperSignerProviderError>);

    await expect(
      CasperSignerProvider.enterpriseCustodyUnavailable().getClientSigner({
        network: CASPER_X402_TESTNET_NETWORK,
      }),
    ).rejects.toMatchObject({
      code: 'CASPER_SIGNER_UNAVAILABLE',
    } satisfies Partial<CasperSignerProviderError>);
  });
});
