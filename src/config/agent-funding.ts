import type { Env } from './env.js';
import { createLiveCep18CallSubmitter } from '../lib/casper/cep18-token-client.js';
import { createNativeCsprTransferSubmitter } from '../lib/casper/odra-anchorer.js';
import { createOnChainReaders, resolveWcsprBalancesUref } from '../lib/casper/cep18-balance-reader.js';
import type { AgentFundingDeps } from '../engines/custody/agent-funding.js';

/**
 * Build the live JIT agent-funding deps for the TESTNET slot from env. Returns undefined when funding
 * is not fully configured (no WCSPR package, no operator, no RPC, or the balances uref cannot be
 * resolved) — the treasury route then runs today's float path verbatim (additive fence).
 *
 * The chain name is taken from `CASPER_GUARD_ODRA_CHAIN_NAME`, defaulting to `casper-test`; note that
 * the CEP-18 submitter must sign for the SAME network the RPC points at.
 */
export async function buildAgentFundingDeps(
  env: Env,
  pemPath: string,
): Promise<AgentFundingDeps | undefined> {
  const rpcUrl = env.CASPER_GUARD_FACILITATOR_RPC_URL || env.CASPER_GUARD_ODRA_RPC_URL;
  const wcsprPackageHash = env.DEMO_CSPR_TOKEN_PACKAGE_HASH;
  const operatorAccountHash = env.CASPER_OPERATOR_ACCOUNT_HASH;

  if (rpcUrl === '' || wcsprPackageHash === '' || operatorAccountHash === '' || pemPath === '') {
    return undefined;
  }

  const balancesUref = await resolveWcsprBalancesUref({ rpcUrl, packageHash: wcsprPackageHash });
  if (!balancesUref) return undefined;

  const chainName = env.CASPER_GUARD_ODRA_CHAIN_NAME || 'casper-test';

  const tokenSubmitter = createLiveCep18CallSubmitter({
    rpcUrl,
    pemPath,
    algorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
    chainName,
  });
  const nativeSubmitter = createNativeCsprTransferSubmitter({
    rpcUrl,
    pemPath,
    algorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
    chainName,
  });
  const readers = createOnChainReaders({
    rpcUrl,
    wcsprPackageHash,
    operatorAccountHash,
    balancesUref,
  });

  return {
    tokenSubmitter,
    nativeSubmitter,
    readWcsprBalance: readers.readWcsprBalance,
    readOperatorWcsprBalance: readers.readOperatorWcsprBalance,
    readAccountPurseExists: readers.readAccountPurseExists,
    wcsprPackageHash,
    operatorAccountHash,
    dustMotes: '2500000000', // 2.5 CSPR — see plan Task 4 Step 5 DUST NOTE.
  };
}
