import type pg from 'pg';
import type { CasperClientSigner, CasperNetwork } from '../../lib/casper/x402.js';
import type { KeyVault } from './key-vault.js';
import { readActiveDelegatedKey } from '../identity/delegation/delegated-keys-store.js';

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

export interface DelegationAwareClientSignerProvider {
  getClientSigner(input: { network: CasperNetwork; agentId?: string }): Promise<CasperClientSigner>;
}

/**
 * B.4: wraps the existing per-network `getClientSigner({ network })` seam with agent-aware
 * delegation. Fits `CasperClientSignerProvider` from config/casper-guard.ts exactly (an extra
 * optional `agentId` widens, never narrows, the input type — legacy call sites that omit it keep
 * working unchanged and always fall back to the custodial provider).
 */
export function createDelegationAwareSignerProvider(input: {
  pool: pg.Pool;
  vault: KeyVault;
  fallbackProvider: CasperClientSignerProviderLike;
}): DelegationAwareClientSignerProvider {
  return {
    async getClientSigner({ network, agentId }) {
      if (!agentId) {
        return input.fallbackProvider.getClientSigner({ network });
      }
      const active = await readActiveDelegatedKey(input.pool, { agentId });
      return resolveAgentCasperSigner({
        vault: input.vault,
        agentId,
        delegatedPublicKeyHex: active?.publicKey,
        network,
        fallbackProvider: input.fallbackProvider,
      });
    },
  };
}
