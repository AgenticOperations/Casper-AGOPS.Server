import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { viemTokenDomainSource, type ArcPublicClient } from '../../src/lib/arc/client.js';

/**
 * The live EIP-712 domain source is a two-rung dynamic read: prefer EIP-5267 `eip712Domain()`, then fall
 * back to `name()`/`version()` views. This second rung is REQUIRED for Arc testnet USDC, which implements
 * name()/version() but REVERTS eip712Domain() — without it the hot path would sign a possibly-wrong
 * constant. (Verified on-chain: name="USDC",version="2" reproduces the Arc USDC DOMAIN_SEPARATOR.)
 */
const TOKEN = '0x3600000000000000000000000000000000000000' as Address;

/** A minimal viem-PublicClient stand-in: scripts readContract by functionName + getChainId. */
function mockClient(opts: {
  eip712Domain?: () => unknown;
  name?: string;
  version?: string;
  chainId?: number;
}): ArcPublicClient {
  return {
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === 'eip712Domain') {
        if (!opts.eip712Domain) throw new Error('execution reverted');
        return Promise.resolve(opts.eip712Domain());
      }
      if (functionName === 'name') {
        if (opts.name === undefined) throw new Error('execution reverted');
        return Promise.resolve(opts.name);
      }
      if (functionName === 'version') {
        if (opts.version === undefined) throw new Error('execution reverted');
        return Promise.resolve(opts.version);
      }
      throw new Error(`unexpected fn ${functionName}`);
    },
    getChainId: () => Promise.resolve(opts.chainId ?? 5042002),
  } as unknown as ArcPublicClient;
}

describe('viemTokenDomainSource (two-rung live read)', () => {
  it('falls back to name()/version() when eip712Domain() reverts (the Arc USDC case)', async () => {
    const src = viemTokenDomainSource(mockClient({ name: 'USDC', version: '2', chainId: 5042002 }));
    const domain = await src.readEip712Domain({ address: TOKEN });
    expect(domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 5042002n,
      verifyingContract: TOKEN,
    });
  });

  it('prefers eip712Domain() when the token implements EIP-5267', async () => {
    const src = viemTokenDomainSource(
      mockClient({
        eip712Domain: () => ['0x0f', 'USD Coin', '2', 1n, TOKEN, '0x', []],
        name: 'SHOULD_NOT_BE_USED',
        version: '9',
      }),
    );
    const domain = await src.readEip712Domain({ address: TOKEN });
    expect(domain?.name).toBe('USD Coin');
    expect(domain?.version).toBe('2');
  });

  it('returns null when BOTH rungs revert (fail-closed → registry / no-quote)', async () => {
    const src = viemTokenDomainSource(mockClient({}));
    expect(await src.readEip712Domain({ address: TOKEN })).toBeNull();
  });
});
