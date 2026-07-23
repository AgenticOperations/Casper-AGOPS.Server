import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const MINIMAL = {
  DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

describe('CASPER_GUARD_VAULT_MASTER_SECRET (Milestone B env wiring)', () => {
  it('defaults to empty string when unset', () => {
    const env = loadEnv(MINIMAL as never);
    expect(env.CASPER_GUARD_VAULT_MASTER_SECRET).toBe('');
  });

  it('is read through when set', () => {
    const env = loadEnv({ ...MINIMAL, CASPER_GUARD_VAULT_MASTER_SECRET: 'a-real-secret' } as never);
    expect(env.CASPER_GUARD_VAULT_MASTER_SECRET).toBe('a-real-secret');
  });
});
