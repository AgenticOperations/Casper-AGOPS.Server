import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  registryKey,
  resolveTokenDomain,
  UnsupportedTokenError,
  type KnownTokenRegistry,
  type TokenDomainSource,
} from '../../src/lib/eip712/domain.js';

/**
 * Thesis claim: the USDC EIP-712 domain is resolved via the EIP-5267 ladder, never hardcoded
 * (policy-engine-FINAL.md:194-199).
 */

const TOKEN = '0x3600000000000000000000000000000000000000' as Address; // Arc testnet USDC
const CHAIN = 5042002;

describe('EIP-5267 domain ladder (never hardcode the USDC domain)', () => {
  it('prefers eip712Domain() — the on-chain result wins over the registry', async () => {
    const source: TokenDomainSource = {
      readEip712Domain: () =>
        Promise.resolve({
          name: 'USD Coin',
          version: '2',
          chainId: BigInt(CHAIN),
          verifyingContract: TOKEN,
        }),
    };
    // A registry that would give a *different* answer — must be ignored when the view resolves.
    const registry: KnownTokenRegistry = new Map([
      [registryKey(CHAIN, TOKEN), { name: 'Wrong', version: '9' }],
    ]);

    const domain = await resolveTokenDomain(source, { chainId: CHAIN, tokenAddress: TOKEN, registry });
    expect(domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: CHAIN,
      verifyingContract: TOKEN,
    });
  });

  it('falls back to the known-token registry when the view is unavailable', async () => {
    const source: TokenDomainSource = { readEip712Domain: () => Promise.resolve(null) };
    const registry: KnownTokenRegistry = new Map([
      [registryKey(CHAIN, TOKEN), { name: 'USD Coin', version: '1' }],
    ]);

    const domain = await resolveTokenDomain(source, { chainId: CHAIN, tokenAddress: TOKEN, registry });
    expect(domain.version).toBe('1'); // chain-specific; proves it is not pinned to "2"
    expect(domain.verifyingContract).toBe(TOKEN);
  });

  it('fails closed with unsupported_token when neither resolves', async () => {
    const source: TokenDomainSource = { readEip712Domain: () => Promise.resolve(null) };
    await expect(
      resolveTokenDomain(source, { chainId: CHAIN, tokenAddress: TOKEN }),
    ).rejects.toBeInstanceOf(UnsupportedTokenError);
  });
});
