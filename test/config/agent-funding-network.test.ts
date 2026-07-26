import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

/*
 * Agent funding used to read the TESTNET env vars unconditionally and was built once at boot, so a
 * MAINNET top-up was signed with chain name `casper-test` and every mainnet node rejected it with
 * `-32016 Invalid transaction: The transaction sent to the network had an invalid chain name`.
 *
 * These pin the per-network separation at the env layer: each slot must resolve its OWN rpc,
 * operator account, and WCSPR package. (The submitters themselves need a reachable node and a real
 * PEM, so they are exercised in the live path rather than here.)
 */
const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
  CASPER_OPERATOR_ACCOUNT_HASH: 'a'.repeat(64),
  DEMO_CSPR_TOKEN_PACKAGE_HASH: 'b'.repeat(64),
  CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL: 'https://node.mainnet.casper.network/rpc',
  CASPER_MAINNET_OPERATOR_ACCOUNT_HASH: 'c'.repeat(64),
  DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH: 'd'.repeat(64),
};

describe('agent funding env is separated per network', () => {
  it('exposes a distinct mainnet WCSPR package hash', () => {
    const env = loadEnv(BASE);
    expect(env.DEMO_CSPR_TOKEN_PACKAGE_HASH).toBe('b'.repeat(64));
    expect(env.DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH).toBe('d'.repeat(64));
    // The bug this guards: one hash serving both networks.
    expect(env.DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH).not.toBe(env.DEMO_CSPR_TOKEN_PACKAGE_HASH);
  });

  it('keeps mainnet rpc and operator distinct from testnet', () => {
    const env = loadEnv(BASE);
    expect(env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL).not.toBe(env.CASPER_GUARD_FACILITATOR_RPC_URL);
    expect(env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH).not.toBe(env.CASPER_OPERATOR_ACCOUNT_HASH);
  });

  it('defaults the mainnet token hash to empty so mainnet funding stays off until set', () => {
    const { DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH: _omitted, ...withoutMainnetToken } = BASE;
    const env = loadEnv(withoutMainnetToken);
    // Empty → buildAgentFundingDeps returns undefined for mainnet → route skips on-chain funding
    // rather than falling back to the testnet slot and signing the wrong chain name.
    expect(env.DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH).toBe('');
  });

  it('rejects a malformed mainnet token hash instead of accepting it silently', () => {
    expect(() =>
      loadEnv({ ...BASE, DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH: 'not-a-hash' }),
    ).toThrow();
  });
});
