import type { Cep18CallSubmitter } from '../../lib/casper/cep18-token-client.js';
import type { KeyVault } from './key-vault.js';
import {
  buildVaultSignedTransferAuthorization,
  type BuildAuthorizationInput,
  type VaultSignedAuthorizationResult,
} from './wcspr-authorization.js';

/**
 * Retire-time sweep of an agent's WCSPR back to the operator (full-loop closure).
 *
 * The operator CANNOT `transfer` WCSPR out of the agent account (no allowance), so the sweep uses the
 * SAME `transfer_with_authorization` rail the payment path uses, directed agent→operator: the agent's
 * VAULT key signs an authorization moving its WCSPR to the operator, and the OPERATOR submits it
 * (operator pays gas). Best-effort / non-blocking — the caller wraps this in try/catch on teardown.
 */

// 3 CSPR gas cap (matches the CEP-18 calls validated in Task 2).
const TWA_PAYMENT_MOTES = 3_000_000_000;

export interface SweepDeps {
  tokenSubmitter: Cep18CallSubmitter;
  readWcsprBalance: (accountHash: string) => Promise<bigint>;
  vault: KeyVault;
  wcsprPackageHash: string;
  operatorAccountHash: string;
  domainName: string;
  domainVersion: string;
  chainName: string;
  maxTimeoutSeconds: number;
  /** Injected builder (defaults to the real one); overridable for tests. */
  buildAuthorization?: (input: BuildAuthorizationInput) => Promise<VaultSignedAuthorizationResult>;
  /** Injected library seams for the digest (defaults wired in the live factory). */
  hashTypedData?: BuildAuthorizationInput['hashTypedData'];
  buildDomain?: BuildAuthorizationInput['buildDomain'];
  casperDomainTypes?: unknown;
}

export interface SweepResult {
  swept: bigint;
  txHash?: string;
}

export async function sweepAgentWcsprOnChain(
  deps: SweepDeps,
  input: { agentId: string; agentAccountHash: string; agentPublicKeyHex: string },
): Promise<SweepResult> {
  const balance = await deps.readWcsprBalance(input.agentAccountHash);
  if (balance === 0n) return { swept: 0n };

  const build = deps.buildAuthorization ?? buildVaultSignedTransferAuthorization;
  const signed = await build({
    vault: deps.vault,
    agentId: input.agentId,
    fromAccountHash: input.agentAccountHash,
    toAccountHash: deps.operatorAccountHash,
    amountMotes: balance.toString(),
    publicKeyHex: input.agentPublicKeyHex,
    domainName: deps.domainName,
    domainVersion: deps.domainVersion,
    assetContractHash: deps.wcsprPackageHash,
    chainName: deps.chainName,
    maxTimeoutSeconds: deps.maxTimeoutSeconds,
    // These are only consumed by the real builder; the injected test builder ignores them.
    hashTypedData: deps.hashTypedData as BuildAuthorizationInput['hashTypedData'],
    buildDomain: deps.buildDomain as BuildAuthorizationInput['buildDomain'],
    casperDomainTypes: deps.casperDomainTypes,
  });

  const { txHash } = await deps.tokenSubmitter.call({
    packageHash: deps.wcsprPackageHash,
    entryPoint: 'transfer_with_authorization',
    args: signed.args,
    paymentMotes: TWA_PAYMENT_MOTES,
  });

  return { swept: balance, txHash };
}
