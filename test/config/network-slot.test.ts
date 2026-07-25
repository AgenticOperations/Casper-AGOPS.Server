import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { resolveCasperNetworkSlot } from '../../src/config/network-slot.js';

const baseEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
  CASPER_OPERATOR_ACCOUNT_HASH: '60854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267',
  CASPER_GUARD_ODRA_RPC_URL: 'http://65.109.115.124:7777',
  CASPER_GUARD_ODRA_PACKAGE_HASH: '850b50564515abfb90e149c253c0e1185ef1d98b60748967741ad7a1a9e7d7ed',
  CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL: 'https://node.mainnet.casper.network/rpc',
  CASPER_MAINNET_OPERATOR_ACCOUNT_HASH: 'f9765d218cf1ee95e92097658da1e23cadf1e401e3e7881e3937a2971ba94dd3',
  CASPER_GUARD_MAINNET_ODRA_RPC_URL: 'https://node.mainnet.casper.network/rpc',
  CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH: 'a003b2c32c6c7bddbd51d9596a31af72e0cdad62268a3747147d809add7ff629',
};

describe('resolveCasperNetworkSlot', () => {
  it('returns testnet-slot values for casper:casper-test', () => {
    const env = loadEnv(baseEnv as NodeJS.ProcessEnv);
    const slot = resolveCasperNetworkSlot(env, 'casper:casper-test');
    expect(slot.facilitatorRpcUrl).toBe('https://node.testnet.casper.network/rpc');
    expect(slot.operatorAccountHash).toBe('60854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267');
    expect(slot.odraPackageHash).toBe('850b50564515abfb90e149c253c0e1185ef1d98b60748967741ad7a1a9e7d7ed');
  });

  it('returns mainnet-slot values for casper:casper', () => {
    const env = loadEnv(baseEnv as NodeJS.ProcessEnv);
    const slot = resolveCasperNetworkSlot(env, 'casper:casper');
    expect(slot.facilitatorRpcUrl).toBe('https://node.mainnet.casper.network/rpc');
    expect(slot.operatorAccountHash).toBe('f9765d218cf1ee95e92097658da1e23cadf1e401e3e7881e3937a2971ba94dd3');
    expect(slot.odraPackageHash).toBe('a003b2c32c6c7bddbd51d9596a31af72e0cdad62268a3747147d809add7ff629');
  });
});
