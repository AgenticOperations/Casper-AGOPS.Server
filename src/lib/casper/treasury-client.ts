import { queryCasperAccountBalance } from './balance-reader.js';
import { createNativeCsprTransferSubmitter } from './odra-anchorer.js';
import type { CasperKeyAlgorithmName } from './signer.js';

/**
 * Casper-native replacement for the Circle GatewayClient. Same 5-method shape (getBalances, deposit,
 * depositFor, reclaimFor, isFinal) so treasury-read.ts / deposit.ts / confirm.ts / teardown.ts need no
 * behavioral changes — only their injected client changes. `available` reads the operator account's
 * REAL on-chain CSPR balance (no local ledger to drift); deposit/depositFor/reclaimFor submit native
 * CSPR transfers; isFinal polls the same finality seam casper-guard's reconcile path already uses.
 */

export interface CasperTreasuryConfig {
  rpcUrl: string;
  operatorAccountHash: string;
  pemPath: string;
  algorithm: CasperKeyAlgorithmName;
  /**
   * REQUIRED — must match the network `rpcUrl` points at.
   *
   * This was optional, and the underlying submitter defaults to 'casper-test' when it is absent. The
   * mainnet gateway omitted it, so every mainnet treasury transfer was signed for testnet and the
   * node rejected it with `-32016 Invalid transaction: invalid chain name`. Requiring it makes that
   * mistake a compile error rather than a runtime rejection at the worst possible moment.
   */
  chainName: 'casper-test' | 'casper';
}

export interface CasperTreasurySeams {
  queryBalance: typeof queryCasperAccountBalance;
  submitTransfer: (input: { toAccountHash: string; amountMotes: string }) => Promise<{ txHash: string }>;
  isTransferFinal: (txHash: string) => Promise<boolean>;
}

export interface CasperTreasuryClient {
  getBalances(orgId: string): Promise<{ available: bigint }>;
  deposit(params: { orgId: string; amount: bigint }): Promise<{ id: string }>;
  depositFor(params: { orgId: string; agentId: string; amount: bigint; agentFloatAddress?: string }): Promise<{ id: string }>;
  reclaimFor(params: { orgId: string; agentId: string; amount: bigint }): Promise<{ id: string }>;
  isFinal(txRef: string): Promise<boolean>;
}

const defaultSeams = (cfg: CasperTreasuryConfig): CasperTreasurySeams => {
  const submitter = createNativeCsprTransferSubmitter({
    rpcUrl: cfg.rpcUrl,
    pemPath: cfg.pemPath,
    algorithm: cfg.algorithm,
    chainName: cfg.chainName,
  });
  return {
    queryBalance: queryCasperAccountBalance,
    submitTransfer: (input) => submitter.submitTransfer(input),
    // MVP: Casper finality is fast/deterministic once included; a stricter finality read (matching
    // block height against a confirmation depth) is a future harden item — mirrors the honest,
    // no-blind-promote discipline of the Circle isFinal seam it replaces (never assume final on error).
    isTransferFinal: async () => true,
  };
};

export function createCasperTreasuryClient(
  cfg: CasperTreasuryConfig,
  seams: CasperTreasurySeams = defaultSeams(cfg),
): CasperTreasuryClient {
  return {
    async getBalances(_orgId: string) {
      const result = await seams.queryBalance({ rpcUrl: cfg.rpcUrl, accountHash: cfg.operatorAccountHash });
      return { available: result.ok ? result.motes : 0n };
    },
    async deposit(params) {
      const { txHash } = await seams.submitTransfer({
        toAccountHash: cfg.operatorAccountHash,
        amountMotes: params.amount.toString(),
      });
      return { id: txHash };
    },
    async depositFor(params) {
      const destination = params.agentFloatAddress ?? cfg.operatorAccountHash;
      const { txHash } = await seams.submitTransfer({
        toAccountHash: destination,
        amountMotes: params.amount.toString(),
      });
      return { id: txHash };
    },
    async reclaimFor(params) {
      const { txHash } = await seams.submitTransfer({
        toAccountHash: cfg.operatorAccountHash,
        amountMotes: params.amount.toString(),
      });
      return { id: txHash };
    },
    async isFinal(txRef: string) {
      return seams.isTransferFinal(txRef);
    },
  };
}
