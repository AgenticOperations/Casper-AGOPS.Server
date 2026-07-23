import type { CasperClientSigner, CasperNetwork } from '../../lib/casper/x402.js';
import type { KeyVault } from './key-vault.js';

const importRuntime = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ specifier) as Promise<unknown>;

type CasperSdkPublicKey = {
  PublicKey: {
    fromHex(hex: string): { accountHash(): { hashBytes: Uint8Array } };
  };
};

/**
 * Adapts a KeyVault (agent-scoped, raw-byte signing) to the CasperClientSigner shape the x402
 * client path expects. B.4 (D-3): each agent's delegated key signs only for that agent.
 */
export function createVaultCasperClientSigner(input: {
  vault: KeyVault;
  agentId: string;
  publicKeyHex: string;
  accountAddress: string;
}): CasperClientSigner {
  return {
    publicKey: () => input.publicKeyHex,
    accountAddress: () => input.accountAddress,
    signEIP712: (digest: Uint8Array) => input.vault.signWith(input.agentId, digest),
  };
}

/** Derives the "00" + hex account-hash address format used elsewhere in this repo (PAY_TO_ACCOUNT_HASH). */
export async function deriveCasperAccountAddress(publicKeyHex: string): Promise<string> {
  const sdk = (await importRuntime('casper-js-sdk')) as CasperSdkPublicKey;
  const accountHash = sdk.PublicKey.fromHex(publicKeyHex).accountHash();
  return '00' + Buffer.from(accountHash.hashBytes).toString('hex');
}

export interface CasperClientSignerProviderLike {
  getClientSigner(input: { network: CasperNetwork }): Promise<CasperClientSigner>;
}

/**
 * B.4: resolve the signer for an authorize call. If the agent has an ACTIVE delegated key
 * (Milestone C's delegated_keys table), sign with it via the vault — never the master key. If
 * not (no delegation granted yet), fall back to the existing custodial PEM provider — the
 * "testnet demo" path (D-1 fallback) that predates per-agent delegation.
 */
export async function resolveAgentCasperSigner(input: {
  vault: KeyVault;
  agentId: string;
  delegatedPublicKeyHex: string | undefined;
  network: CasperNetwork;
  fallbackProvider: CasperClientSignerProviderLike;
}): Promise<CasperClientSigner> {
  if (input.delegatedPublicKeyHex) {
    const accountAddress = await deriveCasperAccountAddress(input.delegatedPublicKeyHex);
    return createVaultCasperClientSigner({
      vault: input.vault,
      agentId: input.agentId,
      publicKeyHex: input.delegatedPublicKeyHex,
      accountAddress,
    });
  }

  return input.fallbackProvider.getClientSigner({ network: input.network });
}
