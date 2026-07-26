import type { KeyVault } from './key-vault.js';
import type { ClTypedArg } from '../../lib/casper/cep18-token-client.js';

/**
 * Builds a VAULT-signed `transfer_with_authorization` payload directed agent→dest (the retire sweep).
 *
 * Ports the client-side flow from `@make-software/casper-x402` (chunk-V6D4X6EJ.mjs:54-108) exactly:
 *   - `buildDomain(name, version, chainName, "0x"+assetContractHash)`
 *   - message { from:"0x"+from, to:"0x"+to, value, validAfter, validBefore, nonce:"0x"+hex }
 *     with `validAfter = now-600`, `validBefore = now+maxTimeoutSeconds`, nonce = 32 random bytes.
 *   - digest = `hashTypedData(domain, transferWithAuthorizationTypes, "TransferWithAuthorization", …)`
 *   - signature = vault.signWith(agentId, digest), then TAGGED to 65 bytes ([1-byte ed25519 tag][64 raw])
 *     — same as vault-signer.ts's signEIP712 (the facilitator rejects anything but the 65-byte form).
 *
 * The EIP-712 domain fields (name/version/asset) are INJECTED (no env reads inside the module) so the
 * unit test stays SDK-free and deterministic. Nonce MUST be exactly 32 bytes (the library hard-requires
 * it, chunk-U7JH2PXO.mjs:212). Returns the typed args descriptor (from/to/amount/validity/nonce/
 * public_key/signature) plus the raw authorization for logging.
 */

const ED25519_ALGORITHM_TAG = 1; // Casper sig = [1-byte algorithm tag][64 raw]; vault holds ed25519 keys.

// EIP-712 type set for TransferWithAuthorization (mirrors x402 transferWithAuthorizationTypes).
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export interface TransferAuthorization {
  from: string; // "00"+hex account hash
  to: string; // "00"+hex account hash
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // 32-byte hex (no 0x)
}

export interface VaultSignedAuthorizationResult {
  authorization: TransferAuthorization;
  signatureHex: string; // 65-byte tagged signature hex
  publicKeyHex: string;
  args: {
    from: ClTypedArg;
    to: ClTypedArg;
    amount: ClTypedArg;
    valid_after: ClTypedArg;
    valid_before: ClTypedArg;
    nonce: ClTypedArg;
    public_key: ClTypedArg;
    signature: ClTypedArg;
  };
}

type HashTypedDataFn = (
  domain: unknown,
  types: unknown,
  primaryType: string,
  message: Record<string, unknown>,
  opts: { domainTypes: unknown },
) => Uint8Array;
type BuildDomainFn = (name: string, version: string, chainName: string, asset: string) => unknown;

export interface BuildAuthorizationInput {
  vault: KeyVault;
  agentId: string;
  fromAccountHash: string; // agent own account ("00"+hex)
  toAccountHash: string; // operator ("00"+hex)
  amountMotes: string;
  publicKeyHex: string;
  domainName: string;
  domainVersion: string;
  assetContractHash: string; // WCSPR contract hash (no 0x)
  chainName: string; // e.g. "casper-test"
  maxTimeoutSeconds: number;
  nowSeconds?: number;
  // Injected library seams (default to the real ones in the live wiring).
  hashTypedData: HashTypedDataFn;
  buildDomain: BuildDomainFn;
  casperDomainTypes?: unknown;
  randomNonce?: () => Uint8Array;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildVaultSignedTransferAuthorization(
  input: BuildAuthorizationInput,
): Promise<VaultSignedAuthorizationResult> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const validAfter = now - 600;
  const validBefore = now + input.maxTimeoutSeconds;

  const nonce = (input.randomNonce ?? (() => crypto.getRandomValues(new Uint8Array(32))))();
  if (nonce.length !== 32) {
    throw new Error('nonce must be exactly 32 bytes');
  }
  const nonceHex = bytesToHex(nonce);

  const domain = input.buildDomain(
    input.domainName,
    input.domainVersion,
    input.chainName,
    '0x' + input.assetContractHash,
  );

  const message = {
    from: '0x' + input.fromAccountHash,
    to: '0x' + input.toAccountHash,
    value: BigInt(input.amountMotes),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: '0x' + nonceHex,
  };

  const digest = input.hashTypedData(
    domain,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    'TransferWithAuthorization',
    message,
    { domainTypes: input.casperDomainTypes },
  );

  const rawSignature = await input.vault.signWith(input.agentId, digest);
  const tagged = new Uint8Array(1 + rawSignature.length);
  tagged[0] = ED25519_ALGORITHM_TAG;
  tagged.set(rawSignature, 1);
  const signatureHex = bytesToHex(tagged);

  const authorization: TransferAuthorization = {
    from: input.fromAccountHash,
    to: input.toAccountHash,
    value: input.amountMotes,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce: nonceHex,
  };

  return {
    authorization,
    signatureHex,
    publicKeyHex: input.publicKeyHex,
    args: {
      from: { kind: 'account-hash-key', rawHash: input.fromAccountHash.slice(2) },
      to: { kind: 'account-hash-key', rawHash: input.toAccountHash.slice(2) },
      amount: { clType: 'U256', value: input.amountMotes },
      valid_after: { clType: 'U64', value: String(validAfter) },
      valid_before: { clType: 'U64', value: String(validBefore) },
      nonce: { kind: 'list-u8', bytesHex: nonceHex },
      public_key: { kind: 'public-key', publicKeyHex: input.publicKeyHex },
      signature: { kind: 'list-u8', bytesHex: signatureHex },
    },
  };
}
