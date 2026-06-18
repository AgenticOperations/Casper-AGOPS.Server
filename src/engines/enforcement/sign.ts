import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from 'viem';
import type { Quote } from '../../contracts/index.js';
import { buildTransferAuthorization, EIP3009_TYPES, type TransferAuthorization } from '../../lib/eip712/eip3009.js';
import type { KmsSigner } from '../../lib/kms/signer.js';

/**
 * E6 hot-path signing (policy-engine-FINAL.md:189-210, engine-specs-FINAL.md:201).
 *
 * agentOps SIGNS ONLY — it builds the EIP-3009 `transferWithAuthorization` typed data for the quote
 * and signs it with the `agent-float` KMS role (external-spend; the role fence rejects any other
 * operation before a byte is signed). It then performs **verify-before-submit** (BUG-27): it recovers
 * the signer locally and asserts it is the expected `fromAddress`. A signature that does not recover to
 * the agent-float address never leaves this function — a bad domain, a KMS fault, or a wrong key fails
 * closed here rather than producing an unspendable or mis-attributed authorization downstream.
 *
 * The EIP-712 `domain` is resolved UPSTREAM (raw-x402 via the EIP-5267 ladder against the token;
 * circle-nano as the Gateway protocol constant) and passed in, so this module stays transport-free.
 * Raw signature bytes are returned (they are the payment) but MUST NOT be logged (policy-engine:210).
 */

export interface SignedAuthorization {
  authorization: TransferAuthorization;
  signature: Hex;
}

/** Verify-before-submit failure (BUG-27): the produced signature did not recover to `fromAddress`. */
export class SignatureVerificationError extends Error {
  constructor(
    public readonly expected: Address,
    public readonly recovered: Address,
  ) {
    super(`verify-before-submit failed: signature recovered to ${recovered}, expected ${expected}`);
    this.name = 'SignatureVerificationError';
  }
}

export async function signAuthorization(params: {
  signer: KmsSigner;
  quote: Quote;
  /** The agent-float address that holds the float and must be the EIP-3009 `from`. */
  fromAddress: Address;
  domain: TypedDataDomain;
}): Promise<SignedAuthorization> {
  const { signer, quote, fromAddress, domain } = params;

  const { message } = buildTransferAuthorization({
    domain,
    from: fromAddress,
    to: quote.destination as Address,
    value: quote.amount,
    validBefore: BigInt(quote.validBefore),
    // validAfter defaults to 0; nonce is a fresh 256-bit CSPRNG value (never sequential).
  });

  const signature = await signer.signTransfer({
    role: 'agent-float',
    operation: 'external-spend',
    domain,
    message,
  });

  // Verify-before-submit (BUG-27): only a signature that recovers to the agent-float address is safe
  // to hand back. Recovery here also catches a domain/message mismatch the KMS can't see.
  const recovered = await recoverTypedDataAddress({
    domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
    signature,
  });
  if (recovered.toLowerCase() !== fromAddress.toLowerCase()) {
    throw new SignatureVerificationError(fromAddress, recovered);
  }

  return { authorization: message, signature };
}
