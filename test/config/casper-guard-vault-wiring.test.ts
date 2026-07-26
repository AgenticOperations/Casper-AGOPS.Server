import { describe, it, expect, vi } from 'vitest';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { loadEnv } from '../../src/config/env.js';
import { readActiveDelegatedKey } from '../../src/engines/identity/delegation/delegated-keys-store.js';

vi.mock('../../src/engines/identity/delegation/delegated-keys-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readActiveDelegatedKey: vi.fn().mockResolvedValue(null) };
});

const SCHEMA_MIN = {
  DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  CASPER_GUARD_ODRA_PACKAGE_HASH: 'e'.repeat(64),
  CASPER_GUARD_ODRA_RPC_URL: 'https://node.testnet.casper.network/rpc',
  CASPER_GUARD_SIGNER_MODE: 'local-testnet',
  CASPER_GUARD_SIGNER_PEM_PATH: '/tmp/key.pem',
};

describe('buildCasperGuardDeps wires the vault-aware signer when a pool + vault secret are given (deferred B.4 wiring)', () => {
  it('the testnet slot signer resolves per-agent when agentId is passed to sign(), using readActiveDelegatedKey', async () => {
    const env = loadEnv({ ...SCHEMA_MIN, CASPER_GUARD_VAULT_MASTER_SECRET: 'a-real-secret' });
    const fakePool = { query: vi.fn() } as unknown as import('pg').Pool;

    const deps = buildCasperGuardDeps(env, { pool: fakePool });
    const signer = deps.byNetwork?.['casper:casper-test']?.signer;
    expect(signer).toBeDefined();

    // Signing with an agentId must consult readActiveDelegatedKey (proves the delegation-aware
    // provider is actually in the chain, not just the plain custodial provider).
    // The PEM path is fake, so actually producing a signature will fail — irrelevant here; what
    // matters is that readActiveDelegatedKey gets consulted before that failure.
    await signer!
      .sign({
        decisionId: 'cgd_1',
        agentId: 'agt_1',
        intent: {
          kind: 'casper-deploy',
          network: 'casper:casper-test',
          resourceId: 'casper:deploy:guard-registry',
          amount: '0',
          asset: { kind: 'native', symbol: 'CSPR' },
          deployKind: 'transfer',
          target: `00${'b'.repeat(64)}`,
        },
      })
      .catch(() => undefined);

    expect(vi.mocked(readActiveDelegatedKey)).toHaveBeenCalledWith(fakePool, { agentId: 'agt_1' });
  });

  it('without a pool passed in, the signer behaves exactly as before (no vault consultation, even with agentId)', async () => {
    const env = loadEnv({ ...SCHEMA_MIN, CASPER_GUARD_VAULT_MASTER_SECRET: 'a-real-secret' });
    vi.mocked(readActiveDelegatedKey).mockClear();

    const deps = buildCasperGuardDeps(env);
    const signer = deps.byNetwork?.['casper:casper-test']?.signer;
    expect(signer).toBeDefined();

    await signer!
      .sign({
        decisionId: 'cgd_2',
        agentId: 'agt_1',
        intent: {
          kind: 'casper-deploy',
          network: 'casper:casper-test',
          resourceId: 'casper:deploy:guard-registry',
          amount: '0',
          asset: { kind: 'native', symbol: 'CSPR' },
          deployKind: 'transfer',
          target: `00${'b'.repeat(64)}`,
        },
      })
      .catch(() => undefined);

    expect(vi.mocked(readActiveDelegatedKey)).not.toHaveBeenCalled();
  });
});
