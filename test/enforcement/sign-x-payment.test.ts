import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type TypedDataDomain } from 'viem';
import { LocalKmsSigner } from '../../src/lib/kms/signer.js';
import { EIP3009_TYPES } from '../../src/lib/eip712/eip3009.js';
import { signAuthorization, SignatureVerificationError } from '../../src/engines/enforcement/sign.js';
import { encodeXPayment, decodeXPayment } from '../../src/engines/enforcement/x-payment.js';
import type { Quote } from '../../src/contracts/index.js';

/**
 * E6 hot-path signing → X-PAYMENT (policy-engine-FINAL.md:189-210, engine-specs-FINAL.md:201).
 *
 * agentOps SIGNS ONLY: it builds the EIP-3009 `transferWithAuthorization` typed data, signs it with
 * the agent-float KMS role, and — BEFORE returning — recovers the signer locally and asserts it is the
 * agent-float address (verify-before-submit, BUG-27). A signature that does not recover to the expected
 * address never leaves the function. The X-PAYMENT header is the opaque base64url envelope the agent
 * re-submits verbatim; it legitimately carries the signature (that is the payment), but never any raw
 * KEY material. Pure/local — no container runtime, deterministic throwaway anvil keys.
 */

// Well-known public anvil test keys — NOT secrets, throwaway, used only to exercise the signer locally.
const AGENT_FLOAT_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TREASURY_PK = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

const agentFloat = privateKeyToAccount(AGENT_FLOAT_PK);
const treasury = privateKeyToAccount(TREASURY_PK);
const signer = new LocalKmsSigner({ 'agent-float': agentFloat, 'treasury-allocation': treasury });

const NOW = 1_750_000_000;

// Domain as it would be resolved upstream (EIP-5267 ladder for raw-x402); passed into signAuthorization.
const domain: TypedDataDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: 421614,
  verifyingContract: '0x5555555555555555555555555555555555555555',
};

function rawQuote(): Quote {
  return {
    resourceId: 'https://api.vendor.test/v1/forecast',
    amount: 1_000_000n, // 1 USDC
    asset: 'USDC',
    rail: { scheme: 'raw-x402', chain: 'arc' },
    destination: '0x4444444444444444444444444444444444444444',
    verifyingContract: '0x5555555555555555555555555555555555555555',
    x402Scheme: 'exact',
    x402Network: 'arc-testnet',
    originHost: 'api.vendor.test',
    validBefore: NOW + 600,
  };
}

describe('signAuthorization + X-PAYMENT — EIP-3009 sign, verify-before-submit, opaque header', () => {
  it('produces a signature that recovers to the agent-float address (BUG-27 verify passes)', async () => {
    const quote = rawQuote();
    const { authorization, signature } = await signAuthorization({
      signer,
      quote,
      fromAddress: agentFloat.address,
      domain,
    });

    // The authorization binds exactly the quote's economic terms.
    expect(authorization.from).toBe(agentFloat.address);
    expect(authorization.to).toBe(quote.destination);
    expect(authorization.value).toBe(quote.amount);
    expect(authorization.validBefore).toBe(BigInt(quote.validBefore));
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/); // 256-bit CSPRNG, never sequential

    const recovered = await recoverTypedDataAddress({
      domain,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
      signature,
    });
    expect(recovered).toBe(agentFloat.address);
  });

  it('throws SignatureVerificationError when the recovered signer != fromAddress (verify fails closed)', async () => {
    const quote = rawQuote();
    // fromAddress claims the treasury address, but the agent-float role signs → recovered (agent-float)
    // never equals fromAddress (treasury), so verify-before-submit must reject rather than return.
    await expect(
      signAuthorization({ signer, quote, fromAddress: treasury.address, domain }),
    ).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('encodes an opaque base64url X-PAYMENT that round-trips the authorization + wire envelope', async () => {
    const quote = rawQuote();
    const { authorization, signature } = await signAuthorization({
      signer,
      quote,
      fromAddress: agentFloat.address,
      domain,
    });

    const header = encodeXPayment({
      scheme: quote.x402Scheme,
      network: quote.x402Network,
      authorization,
      signature,
    });
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding / '+' / '/'

    const decoded = decodeXPayment(header);
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact'); // echoed from the server's accept, not the internal rail name
    expect(decoded.network).toBe('arc-testnet');
    expect(decoded.payload.signature).toBe(signature);
    expect(decoded.payload.authorization.from).toBe(agentFloat.address);
    expect(decoded.payload.authorization.to).toBe(quote.destination);
    expect(decoded.payload.authorization.value).toBe('1000000'); // uint256 stringified for the wire
    expect(decoded.payload.authorization.validAfter).toBe('0');
    expect(decoded.payload.authorization.validBefore).toBe(String(NOW + 600));
    expect(decoded.payload.authorization.nonce).toBe(authorization.nonce);
  });

  it('is tamper-evident: a mutated authorization no longer recovers to the signer', async () => {
    const quote = rawQuote();
    const { authorization, signature } = await signAuthorization({
      signer,
      quote,
      fromAddress: agentFloat.address,
      domain,
    });

    const tampered = { ...authorization, value: authorization.value + 1n }; // 1 base-unit more
    const recovered = await recoverTypedDataAddress({
      domain,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: tampered,
      signature,
    });
    expect(recovered).not.toBe(agentFloat.address);
  });

  it('never surfaces raw KEY material in the signed result or the encoded header', async () => {
    const quote = rawQuote();
    const result = await signAuthorization({
      signer,
      quote,
      fromAddress: agentFloat.address,
      domain,
    });
    const header = encodeXPayment({
      scheme: quote.x402Scheme,
      network: quote.x402Network,
      authorization: result.authorization,
      signature: result.signature,
    });

    const serialized = JSON.stringify(
      { result, decoded: decodeXPayment(header) },
      (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(serialized).not.toMatch(/privateKey|mnemonic|secret|"seed"|"pk"/i);
  });
});
