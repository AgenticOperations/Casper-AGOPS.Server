import { createPublicClient, http, type PublicClient } from 'viem';
import type { Eip712DomainResult, TokenDomainSource } from '../eip712/domain.js';
import type { NonceReconciler } from '../../engines/enforcement/expiry-check.js';

/**
 * Live Arc wiring — the only place transport-bound chain reads exist (the L1-L7 engines are pure or
 * Redis/Postgres-only, behind seams). Two read-only views back the hot path:
 *
 *   - {@link viemTokenDomainSource} reads EIP-5267 `eip712Domain()` so the USDC EIP-712 domain is
 *     resolved dynamically (version "1" vs "2" by chain), NEVER hardcoded (policy-engine §5.1).
 *   - {@link viemNonceReconciler} reads EIP-3009 `authorizationState(authorizer, nonce)` so
 *     EXPIRY_CHECK settles/expires only on confirmed on-chain nonce consumption (BUG-20/26).
 *
 * Both are read-only: agentOps SIGNS ONLY and never broadcasts. A read failure surfaces as a domain
 * `null` (fail-closed → no quote) or `'rpc_unavailable'` (fail-safe → LOCKED, never a false expiry).
 */

const EIP5267_ABI = [
  {
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'extensions', type: 'uint256[]' },
    ],
  },
] as const;

const EIP3009_ABI = [
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** The older USDC self-description pair (EIP-2612 / EIP-3009 tokens that predate EIP-5267). */
const NAME_VERSION_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

export type ArcPublicClient = PublicClient;

/** A read-only viem client over the Arc JSON-RPC endpoint. */
export function createArcPublicClient(rpcUrl: string): ArcPublicClient {
  return createPublicClient({ transport: http(rpcUrl) });
}

/**
 * Live EIP-712 domain source. A two-rung dynamic read so the USDC domain is NEVER hardcoded
 * (policy-engine §5.1):
 *   1. EIP-5267 `eip712Domain()` — preferred, fully self-describing.
 *   2. fallback to `name()` + `version()` views — the older USDC pattern. Arc testnet USDC implements
 *      these but REVERTS `eip712Domain()`, so without this rung the live read would yield null and the
 *      hot path would sign against a possibly-wrong constant. chainId/verifyingContract come from the
 *      call context. (Verified: name="USDC", version="2" reproduces the on-chain DOMAIN_SEPARATOR.)
 * Returns null only when BOTH rungs fail — fail-closed: `resolveTokenDomain` then falls back to the
 * known-token registry and, failing that, refuses to quote (no domain → no signature).
 */
export function viemTokenDomainSource(client: ArcPublicClient): TokenDomainSource {
  return {
    async readEip712Domain({ address }): Promise<Eip712DomainResult | null> {
      try {
        const [, name, version, chainId, verifyingContract] = await client.readContract({
          address,
          abi: EIP5267_ABI,
          functionName: 'eip712Domain',
        });
        return { name, version, chainId, verifyingContract };
      } catch {
        // EIP-5267 not implemented (revert) — try the name()/version() pair before giving up.
      }
      try {
        const [name, version, chainId] = await Promise.all([
          client.readContract({ address, abi: NAME_VERSION_ABI, functionName: 'name' }),
          client.readContract({ address, abi: NAME_VERSION_ABI, functionName: 'version' }),
          client.getChainId(),
        ]);
        return { name, version, chainId: BigInt(chainId), verifyingContract: address };
      } catch {
        return null;
      }
    },
  };
}

/**
 * EIP-3009 nonce reconciler backed by a live read of `authorizationState` on the token contract.
 * A transient RPC failure returns `'rpc_unavailable'` (NEVER a false `false`), so EXPIRY_CHECK holds
 * the position (LOCKED) rather than blind-dropping a hold that may already have settled (BUG-20/26).
 */
export function viemNonceReconciler(client: ArcPublicClient): NonceReconciler {
  return {
    async wasNonceConsumed({ token, authorizer, nonce }): Promise<boolean | 'rpc_unavailable'> {
      try {
        return await client.readContract({
          address: token,
          abi: EIP3009_ABI,
          functionName: 'authorizationState',
          args: [authorizer, nonce],
        });
      } catch {
        return 'rpc_unavailable';
      }
    },
  };
}
