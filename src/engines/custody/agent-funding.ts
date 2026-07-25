/**
 * JIT on-chain agent funding (Task 4).
 *
 * Mirrors the reserved ledger amount into the agent's OWN on-chain account as WCSPR, so x402
 * `transfer_with_authorization` settlements stop failing with `User error: 60001` (agent holds no
 * WCSPR). Runs ONLY after a passing `evaluateAllocation` reserve, for the reserved amount.
 *
 * The sequence is idempotent — each step reads state first and acts only on a real shortfall:
 *   1. Ensure the operator holds >= amount WCSPR; wrap (deposit) the shortfall if not.
 *   2. Ensure the agent's main purse exists (native dust) so it can later sign/submit.
 *   3. Transfer the exact WCSPR to the agent account (operator-signed).
 *
 * All on-chain calls go through injected interfaces — no unit test loads casper-js-sdk or hits chain.
 */

import {
  buildCep18TransferArgs,
  buildWcsprDepositArgs,
  type Cep18CallSubmitter,
} from '../../lib/casper/cep18-token-client.js';
import type { NativeCsprTransferSubmitter } from '../../lib/casper/odra-anchorer.js';

export interface AgentFundingDeps {
  tokenSubmitter: Cep18CallSubmitter;
  nativeSubmitter: NativeCsprTransferSubmitter;
  readWcsprBalance: (accountHash: string) => Promise<bigint>;
  readOperatorWcsprBalance: () => Promise<bigint>;
  readAccountPurseExists: (accountHash: string) => Promise<boolean>;
  wcsprPackageHash: string;
  operatorAccountHash: string;
  /** Native CSPR (motes) to seed the agent's main purse. Default 2.5 CSPR (see plan Task 4 Step 5). */
  dustMotes: string;
}

export interface FundAgentResult {
  transferTxHash: string;
  wrapTxHash?: string;
  dustTxHash?: string;
}

// 3 CSPR gas cap for CEP-18 contract calls (deposit / transfer), matching the Task 2 chain runs.
const CEP18_PAYMENT_MOTES = 3_000_000_000;

export async function fundAgentOnChain(
  deps: AgentFundingDeps,
  input: { agentAccountHash: string; amountMotes: string },
): Promise<FundAgentResult> {
  const amount = BigInt(input.amountMotes);
  const result: Partial<FundAgentResult> = {};

  // 1. Ensure operator holds >= amount WCSPR; wrap the shortfall if not (idempotent: read first).
  const opBal = await deps.readOperatorWcsprBalance();
  if (opBal < amount) {
    const shortfall = (amount - opBal).toString();
    const { txHash } = await deps.tokenSubmitter.call({
      packageHash: deps.wcsprPackageHash,
      entryPoint: 'deposit',
      args: buildWcsprDepositArgs({ amountMotes: shortfall }),
      paymentMotes: CEP18_PAYMENT_MOTES,
    });
    result.wrapTxHash = txHash;
  }

  // 2. Ensure the agent main purse exists so it can later sign/submit (idempotent).
  const purse = await deps.readAccountPurseExists(input.agentAccountHash);
  if (!purse) {
    const { txHash } = await deps.nativeSubmitter.submitTransfer({
      toAccountHash: input.agentAccountHash,
      amountMotes: deps.dustMotes,
    });
    result.dustTxHash = txHash;
  }

  // 3. Transfer the exact WCSPR to the agent account (operator-signed).
  const transfer = await deps.tokenSubmitter.call({
    packageHash: deps.wcsprPackageHash,
    entryPoint: 'transfer',
    args: buildCep18TransferArgs({
      recipientAccountHash: input.agentAccountHash,
      amountMotes: input.amountMotes,
    }),
    paymentMotes: CEP18_PAYMENT_MOTES,
  });
  result.transferTxHash = transfer.txHash;
  return result as FundAgentResult;
}
