import type { Env } from './env.js';
import { createLiveCep18CallSubmitter } from '../lib/casper/cep18-token-client.js';
import { createNativeCsprTransferSubmitter } from '../lib/casper/odra-anchorer.js';
import { createOnChainReaders, resolveWcsprBalancesUref } from '../lib/casper/cep18-balance-reader.js';
import type { AgentFundingDeps } from '../engines/custody/agent-funding.js';

/**
 * Build the live JIT agent-funding deps for ONE network slot. Returns undefined when that slot is
 * not fully configured (no WCSPR package, no operator, no RPC, no PEM, or the balances uref cannot
 * be resolved) — the treasury route then runs the float path without on-chain funding.
 *
 * Per-network by construction: this used to read the testnet env vars unconditionally and was built
 * once at boot, so a MAINNET top-up signed with `casper-test` and every mainnet node rejected it
 * with `-32016 Invalid transaction: invalid chain name`.
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

/**
 * Per-network funding inputs. Every field must come from the SAME network's slot: mixing them (a
 * testnet RPC with a mainnet operator, or a testnet token hash on mainnet) produces transactions the
 * target node rejects — `-32016 Invalid transaction: invalid chain name` when the chain name is
 * wrong, or a transfer against a non-existent contract when the token hash is.
 */
function fundingSlotFields(env: Env, network: 'casper:casper-test' | 'casper:casper') {
  return network === 'casper:casper'
    ? {
        rpcUrl: env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL || env.CASPER_GUARD_MAINNET_ODRA_RPC_URL,
        wcsprPackageHash: env.DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH,
        operatorAccountHash: env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH,
        algorithm: env.CASPER_GUARD_MAINNET_SIGNER_ALGORITHM,
        fallbackChainName: 'casper',
      }
    : {
        rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL || env.CASPER_GUARD_ODRA_RPC_URL,
        wcsprPackageHash: env.DEMO_CSPR_TOKEN_PACKAGE_HASH,
        operatorAccountHash: env.CASPER_OPERATOR_ACCOUNT_HASH,
        algorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
        fallbackChainName: 'casper-test',
      };
}

export async function buildAgentFundingDeps(
  env: Env,
  pemPath: string,
  network: 'casper:casper-test' | 'casper:casper' = 'casper:casper-test',
): Promise<AgentFundingDeps | undefined> {
  const slot = fundingSlotFields(env, network);
  const rpcUrl = slot.rpcUrl;
  const wcsprPackageHash = slot.wcsprPackageHash;
  const operatorAccountHash = slot.operatorAccountHash;

  if (rpcUrl === '' || wcsprPackageHash === '' || operatorAccountHash === '' || pemPath === '') {
    return undefined;
  }

  const balancesUref = await resolveWcsprBalancesUref({ rpcUrl, packageHash: wcsprPackageHash });
  if (!balancesUref) return undefined;

  // Chain name MUST match the network the RPC points at, or the node rejects every signed tx with
  // `-32016 Invalid transaction`. `.env`'s CASPER_GUARD_ODRA_CHAIN_NAME can be stale (e.g. `casper`
  // while the RPC is testnet), so resolve it from the node itself via `info_get_status`
  // (`chainspec_name`), falling back to the env value only if the query fails.
  // Resolved from THIS slot's node, so a mainnet slot signs `casper` and a testnet slot
  // `casper-test`. The fallback is the slot's own name — never the testnet default for both.
  const chainName = (await resolveChainNameFromNode(rpcUrl)) ?? slot.fallbackChainName;

  const tokenSubmitter = createLiveCep18CallSubmitter({
    rpcUrl,
    pemPath,
    algorithm: slot.algorithm,
    chainName,
  });
  const nativeSubmitter = createNativeCsprTransferSubmitter({
    rpcUrl,
    pemPath,
    algorithm: slot.algorithm,
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
