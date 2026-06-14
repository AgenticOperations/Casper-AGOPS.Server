import { randomBytes } from 'node:crypto';
import type { Address, Hex, TypedDataDomain } from 'viem';

/**
 * EIP-3009 `transferWithAuthorization` typed data (policy-engine-FINAL.md:128-132).
 *
 * agentOps SIGNS ONLY — it never broadcasts in this engine. The signed authorization is
 * returned to the agent at the authorize() response (Phase-1 custody transfer, BUG-41); the
 * agent submits it. The nonce is a 256-bit CSPRNG value, never sequential or timestamp-derived
 * (engine-specs-FINAL.md:201).
 */

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface TransferAuthorizationTypedData {
  domain: TypedDataDomain;
  types: typeof EIP3009_TYPES;
  primaryType: 'TransferWithAuthorization';
  message: TransferAuthorization;
}

/** 256-bit CSPRNG nonce. */
export function generateNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

export function buildTransferAuthorization(params: {
  domain: TypedDataDomain;
  from: Address;
  to: Address;
  value: bigint;
  validAfter?: bigint;
  validBefore: bigint;
  nonce?: Hex;
}): TransferAuthorizationTypedData {
  return {
    domain: params.domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: params.from,
      to: params.to,
      value: params.value,
      validAfter: params.validAfter ?? 0n,
      validBefore: params.validBefore,
      nonce: params.nonce ?? generateNonce(),
    },
  };
}
