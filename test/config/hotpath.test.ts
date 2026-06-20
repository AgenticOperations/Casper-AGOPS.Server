import { describe, it, expect, vi } from 'vitest';

/**
 * Docker-free hot-path wiring tests. Covers the deterministic signer + the ARC_LIVE-gated EIP-712 domain
 * source: OFF (default) → the known USDC v2 constant for ANY address; ON → the viem-backed EIP-5267 live
 * read. The live read is mocked here (no chain) so the gate is asserted hermetically and deterministically.
 */

// Hoisted spies the vi.mock factory (hoisted above imports) closes over: we assert that ARC_LIVE='true'
// routes through createArcPublicClient + viemTokenDomainSource (the live read), NOT the local constant.
const { createClientSpy, liveReadSpy } = vi.hoisted(() => ({
  createClientSpy: vi.fn((rpcUrl: string) => ({ __arcClientForRpc: rpcUrl })),
  liveReadSpy: vi.fn((_client: unknown, _args: { address: `0x${string}` }) => Promise.resolve(null)),
}));

vi.mock('../../src/lib/arc/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/arc/client.js')>();
  return {
    ...actual,
    // The client is an opaque token here; the real viem read is exercised in the live-Arc spike (skipped
    // without an RPC). This mock proves the GATE selects the live source, not the constant.
    createArcPublicClient: createClientSpy,
    viemTokenDomainSource: (client: unknown) => ({
      readEip712Domain: (args: { address: `0x${string}` }) => liveReadSpy(client, args),
    }),
  };
});

// Imported AFTER the mock so buildHotPath's transitive import of arc/client.js is the mocked one.
const { loadEnv } = await import('../../src/config/env.js');
const { buildHotPath } = await import('../../src/config/hotpath.js');

const BASE = {
  NODE_ENV: 'test', LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://a:a@localhost:5432/a', REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.example', ARC_CHAIN_ID: '421614',
  ARC_USDC_ADDRESS: '0x5555555555555555555555555555555555555555',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

describe('buildHotPath', () => {
  it('builds a deterministic signer + USDC v2 domain source from env', async () => {
    const env = loadEnv(BASE);
    const hp = buildHotPath(env);
    expect(hp.chainId).toBe(421614);
    const from = await hp.signer.addressFor('agent-float');
    // default well-known anvil agent-float key → fixed address
    expect(from.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    const dom = await hp.tokenDomainSource.readEip712Domain({ address: BASE.ARC_USDC_ADDRESS as `0x${string}` });
    expect(dom).toEqual({
      name: 'USDC', version: '2', chainId: 421614n,
      verifyingContract: BASE.ARC_USDC_ADDRESS,
    });
  });

  it('binds the demo vendor host, returns null for unknown hosts', async () => {
    const env = loadEnv({ ...BASE, DEMO_VENDOR_HOST: 'api.weather.example', DEMO_VENDOR_ADDRESS: '0x4444444444444444444444444444444444444444' });
    const hp = buildHotPath(env);
    expect(await hp.domainRegistry.resolvePaymentAddress('api.weather.example'))
      .toBe('0x4444444444444444444444444444444444444444');
    expect(await hp.domainRegistry.resolvePaymentAddress('evil.example')).toBeNull();
  });

  it('ARC_LIVE unset (default false) yields the labeled USDC v2 CONSTANT for any address — no live read', async () => {
    createClientSpy.mockClear();
    liveReadSpy.mockClear();
    const env = loadEnv(BASE); // ARC_LIVE defaults to 'false'
    expect(env.ARC_LIVE).toBe('false');
    const hp = buildHotPath(env);
    // Any address resolves to the same known-correct constant — proving it is NOT a per-address chain read.
    const other = '0x9999999999999999999999999999999999999999' as `0x${string}`;
    const dom = await hp.tokenDomainSource.readEip712Domain({ address: other });
    expect(dom).toEqual({
      name: 'USDC', version: '2', chainId: 421614n, verifyingContract: other,
    });
    // The live-read path was never constructed nor called.
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(liveReadSpy).not.toHaveBeenCalled();
  });

  it("ARC_LIVE='true' yields the viem-backed live read (delegates to readContract), NOT the constant", async () => {
    createClientSpy.mockClear();
    liveReadSpy.mockClear();
    const env = loadEnv({ ...BASE, ARC_LIVE: 'true' });
    const hp = buildHotPath(env);
    // The client is built from the configured RPC, and the domain source delegates to the live read.
    expect(createClientSpy).toHaveBeenCalledWith(BASE.ARC_RPC_URL);
    const addr = BASE.ARC_USDC_ADDRESS as `0x${string}`;
    await hp.tokenDomainSource.readEip712Domain({ address: addr });
    // It went to the live (viem) read — structurally NOT the always-constant local source.
    expect(liveReadSpy).toHaveBeenCalledWith({ __arcClientForRpc: BASE.ARC_RPC_URL }, { address: addr });
  });
});
