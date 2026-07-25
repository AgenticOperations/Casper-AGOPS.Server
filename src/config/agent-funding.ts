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
/**
 * Resolve the node's chain name via `info_get_status` (`chainspec_name`), e.g. `casper-test` or
 * `casper`. Returns null on any error so the caller can fall back. This is the authoritative source —
 * a signed tx whose chain name != the node's is rejected with `-32016 Invalid transaction`.
 */
async function resolveChainNameFromNode(rpcUrl: string): Promise<string | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info_get_status', params: [] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { chainspec_name?: string } };
    return body.result?.chainspec_name ?? null;
  } catch {
    return null;
  }
}

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

  // Chain name MUST match the network the RPC points at, or the node rejects every signed tx with
  // `-32016 Invalid transaction`. `.env`'s CASPER_GUARD_ODRA_CHAIN_NAME can be stale (e.g. `casper`
  // while the RPC is testnet), so resolve it from the node itself via `info_get_status`
  // (`chainspec_name`), falling back to the env value only if the query fails.
  const chainName =
    (await resolveChainNameFromNode(rpcUrl)) ?? (env.CASPER_GUARD_ODRA_CHAIN_NAME || 'casper-test');

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
