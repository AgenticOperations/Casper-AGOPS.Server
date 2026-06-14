import type { Address, TypedDataDomain } from 'viem';

/**
 * Resolve the EIP-712 domain for an ERC-20 token via the EIP-5267 fallback ladder
 * (policy-engine-FINAL.md:194-199). The USDC domain is NEVER hardcoded: USDC is version "1"
 * on some chains and "2" on others, so a constant would silently sign the wrong domain.
 *
 *   1. eip712Domain() view on the token — always preferred, dynamic.
 *   2. known-token registry keyed by (chainId, address) — the only place a static
 *      name/version may live, as a fallback for tokens that don't implement EIP-5267.
 *   3. reject: unsupported_token — fail-closed.
 *
 * The on-chain read is abstracted behind {@link TokenDomainSource} so this module stays
 * transport-free and unit-testable; the viem-backed source is wired where live reads are
 * needed (M5).
 */

export class UnsupportedTokenError extends Error {
  constructor(chainId: number, tokenAddress: string) {
    super(`unsupported_token: no EIP-712 domain for ${tokenAddress} on chain ${chainId}`);
    this.name = 'UnsupportedTokenError';
  }
}

export interface Eip712DomainResult {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Address;
}

export interface TokenDomainSource {
  /** Reads eip712Domain() from the token; returns null when unimplemented or reverting. */
  readEip712Domain(args: { address: Address }): Promise<Eip712DomainResult | null>;
}

export interface KnownTokenEntry {
  name: string;
  version: string;
}

export type KnownTokenRegistry = Map<string, KnownTokenEntry>;

export function registryKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export async function resolveTokenDomain(
  source: TokenDomainSource,
  params: { chainId: number; tokenAddress: Address; registry?: KnownTokenRegistry },
): Promise<TypedDataDomain> {
  // 1. EIP-5267 view — preferred, dynamic.
  const onchain = await source.readEip712Domain({ address: params.tokenAddress });
  if (onchain) {
    return {
      name: onchain.name,
      version: onchain.version,
      chainId: Number(onchain.chainId),
      verifyingContract: onchain.verifyingContract,
    };
  }

  // 2. known-token registry fallback.
  const entry = params.registry?.get(registryKey(params.chainId, params.tokenAddress));
  if (entry) {
    return {
      name: entry.name,
      version: entry.version,
      chainId: params.chainId,
      verifyingContract: params.tokenAddress,
    };
  }

  // 3. fail-closed.
  throw new UnsupportedTokenError(params.chainId, params.tokenAddress);
}
