import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';

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
