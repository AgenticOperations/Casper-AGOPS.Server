import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { slotNetworkForIntent } from '../../src/engines/casper-guard/mcp.js';
import { selectNetworkSlot } from '../../src/engines/casper-guard/routes.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

const TESTNET_ODRA_ENV = {
  ...BASE_ENV,
  CASPER_GUARD_SIGNER_MODE: 'local-testnet',
  CASPER_GUARD_SIGNER_PEM_PATH: '/keys/casper-testnet.pem',
  CASPER_GUARD_ODRA_PACKAGE_HASH: 'a'.repeat(64),
  CASPER_GUARD_ODRA_RPC_URL: 'https://node.testnet.casper.network/rpc',
};

describe('buildCasperGuardDeps byNetwork', () => {
  it('builds only the testnet slot when only testnet env is configured', () => {
    const deps = buildCasperGuardDeps(loadEnv(TESTNET_ODRA_ENV));
    expect(deps.byNetwork?.['casper:casper-test']).toBeDefined();
    expect(deps.byNetwork?.['casper:casper']).toBeUndefined();
  });

  it('builds both slots with distinct odra package hashes when both networks are configured', () => {
    const deps = buildCasperGuardDeps(
      loadEnv({
        ...TESTNET_ODRA_ENV,
        CASPER_GUARD_NETWORKS: 'casper:casper-test,casper:casper',
        CASPER_GUARD_MAINNET_SIGNER_PEM_PATH: '/keys/casper-mainnet.pem',
        CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH: 'b'.repeat(64),
        CASPER_GUARD_MAINNET_ODRA_RPC_URL: 'https://node.mainnet.casper.network/rpc',
      }),
    );
    const testnetSlot = deps.byNetwork?.['casper:casper-test'];
    const mainnetSlot = deps.byNetwork?.['casper:casper'];
    expect(testnetSlot).toBeDefined();
    expect(mainnetSlot).toBeDefined();
    expect(testnetSlot?.odra?.contractPackage).toBe('a'.repeat(64));
    expect(mainnetSlot?.odra?.contractPackage).toBe('b'.repeat(64));
  });
});

/*
 * MCP tool calls carry no x-agentops-network header, so the intent's own network is the only signal
 * for which slot signs and settles it. These pin that mapping: a mainnet intent must never be
 * executed with testnet key material, and must fail closed when no mainnet slot exists.
 */
describe('MCP intent → network slot routing', () => {
  const BOTH_NETWORKS_ENV = {
    ...TESTNET_ODRA_ENV,
    CASPER_GUARD_NETWORKS: 'casper:casper-test,casper:casper',
    CASPER_GUARD_MAINNET_SIGNER_PEM_PATH: '/keys/casper-mainnet.pem',
    CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH: 'b'.repeat(64),
    CASPER_GUARD_MAINNET_ODRA_RPC_URL: 'https://node.mainnet.casper.network/rpc',
  };

  it('maps casper networks to their own slot and EVM rails to the default', () => {
    expect(slotNetworkForIntent('casper:casper')).toBe('casper:casper');
    expect(slotNetworkForIntent('casper:casper-test')).toBe('casper:casper-test');
    // EVM rails are user-broadcast; the Casper side only records/anchors, so they keep the default.
    expect(slotNetworkForIntent('evm:sepolia')).toBeUndefined();
    expect(slotNetworkForIntent('evm:base-sepolia')).toBeUndefined();
  });

  it('routes a mainnet intent to the MAINNET slot, not testnet', () => {
    const deps = buildCasperGuardDeps(loadEnv(BOTH_NETWORKS_ENV));
    const selection = selectNetworkSlot(deps, slotNetworkForIntent('casper:casper'));
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.network).toBe('casper:casper');
    // The decisive assertion: mainnet key material, not testnet's.
    expect(selection.slot.odra?.contractPackage).toBe('b'.repeat(64));
  });

  it('routes a testnet intent to the testnet slot', () => {
    const deps = buildCasperGuardDeps(loadEnv(BOTH_NETWORKS_ENV));
    const selection = selectNetworkSlot(deps, slotNetworkForIntent('casper:casper-test'));
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.network).toBe('casper:casper-test');
    expect(selection.slot.odra?.contractPackage).toBe('a'.repeat(64));
  });

  it('fails closed on a mainnet intent when no mainnet slot is configured', () => {
    // Testnet-only deployment — the common case. A mainnet intent must be refused outright rather
    // than silently falling back to the testnet signer.
    const deps = buildCasperGuardDeps(loadEnv(TESTNET_ODRA_ENV));
    const selection = selectNetworkSlot(deps, slotNetworkForIntent('casper:casper'));
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.error).toBe('network_not_configured');
  });
});
