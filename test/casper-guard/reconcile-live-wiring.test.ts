import { describe, it, expect } from 'vitest';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { loadEnv } from '../../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

describe('buildCasperGuardDeps settlement wiring', () => {
  it('exposes a live settlement reader factory and liveSettlement.configured=true when a facilitator rpc url is set', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
    });
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement?.configured).toBe(true);
    expect(typeof deps.settlementReaderFactory).toBe('function');
  });

  it('stays honest-blocked (no factory, configured=false) when no rpc url is set', () => {
    const env = loadEnv(BASE);
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement?.configured).toBe(false);
    expect(deps.settlementReaderFactory).toBeUndefined();
  });

  it('the factory returns a reader with a read() function', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
    });
    const deps = buildCasperGuardDeps(env);
    const reader = deps.settlementReaderFactory!();
    expect(typeof reader.read).toBe('function');
  });

  it('uses facilitator settlement reader when CASPER_GUARD_FACILITATOR_URL is set', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
      CASPER_GUARD_FACILITATOR_URL: 'https://x402-facilitator.cspr.cloud',
      CASPER_GUARD_SIGNER_PEM_PATH: '/some/key.pem',
      CASPER_GUARD_SIGNER_MODE: 'local-testnet',
    });
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement?.configured).toBe(true);
    expect(typeof deps.settlementReaderFactory).toBe('function');
    // The factory must return a reader (type check only — no live network call here)
    const reader = deps.settlementReaderFactory!();
    expect(typeof reader.read).toBe('function');
  });

  it('falls back to rpc-only reader when CASPER_GUARD_FACILITATOR_URL is not set', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
      // No CASPER_GUARD_FACILITATOR_URL
    });
    const deps = buildCasperGuardDeps(env);
    expect(typeof deps.settlementReaderFactory).toBe('function');
  });
});
