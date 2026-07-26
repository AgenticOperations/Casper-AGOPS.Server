import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  createOdraGuardRegistryAnchorer,
  createLiveCasperDeploySubmitter,
} from '../../src/lib/casper/odra-anchorer.js';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { loadEnv } from '../../src/config/env.js';
import type { CasperGuardDecisionRecord } from '../../src/engines/casper-guard/store.js';

const require = createRequire(import.meta.url);

const decision = { decisionId: 'cgd_9', orgId: 'org_1', agentId: 'agt_1' } as unknown as CasperGuardDecisionRecord;

describe('OdraGuardRegistryAnchorer', () => {
  it('submits anchor_decision with the id + hash and returns the tx hash', async () => {
    const submit = vi.fn().mockResolvedValue({ txHash: '0xanchored' });
    const anchorer = createOdraGuardRegistryAnchorer({
      packageHash: 'd'.repeat(64),
      entryPoint: 'anchor_decision',
      submitter: { submit },
    });
    const res = await anchorer.anchorDecision({ decisionId: 'cgd_9', decisionHash: 'sha256:abc', decision });
    expect(res.txHash).toBe('0xanchored');
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        packageHash: 'd'.repeat(64),
        entryPoint: 'anchor_decision',
        args: { decision_id: 'cgd_9', decision_hash: 'sha256:abc' },
      }),
    );
  });

  it('throws when the submitter fails (so the anchor is marked failed upstream)', async () => {
    const anchorer = createOdraGuardRegistryAnchorer({
      packageHash: 'd'.repeat(64),
      entryPoint: 'anchor_decision',
      submitter: { submit: vi.fn().mockRejectedValue(new Error('node_unreachable')) },
    });
    await expect(
      anchorer.anchorDecision({ decisionId: 'cgd_9', decisionHash: 'sha256:abc', decision }),
    ).rejects.toThrow('node_unreachable');
  });
});

describe('createLiveCasperDeploySubmitter (Casper 2.0 transaction path)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits via putTransaction (Casper 2.0), never the deprecated putDeploy path', async () => {
    // Casper 2.0 nodes accept putDeploy calls but silently never execute them — a decision can look
    // "confirmed" while nothing lands on-chain. The submitter must go through putTransaction only.
    const sdk = require('casper-js-sdk') as {
      RpcClient: {
        prototype: {
          putDeploy: (...args: unknown[]) => unknown;
          putTransaction: (...args: unknown[]) => unknown;
        };
      };
    };
    const putTransactionSpy = vi
      .spyOn(sdk.RpcClient.prototype, 'putTransaction')
      .mockResolvedValue({ transactionHash: { toHex: () => 'real-tx-hash' } });
    const putDeploySpy = vi.spyOn(sdk.RpcClient.prototype, 'putDeploy');

    const dir = mkdtempSync(join(tmpdir(), 'odra-anchorer-test-'));
    const pemPath = join(dir, 'secret_key.pem');
    // Real ed25519 test key material (not a mainnet/testnet funded account) so PrivateKey.fromPem
    // parses successfully — this proves transaction building/signing works end-to-end.
    const casperSdk = require('casper-js-sdk') as {
      PrivateKey: { generate(alg: unknown): { toPem(): string } };
      KeyAlgorithm: { ED25519: unknown };
    };
    const generated = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
    writeFileSync(pemPath, generated.toPem());

    const submitter = createLiveCasperDeploySubmitter({
      rpcUrl: 'https://node.example.invalid/rpc',
      pemPath,
      algorithm: 'ed25519',
      chainName: 'casper',
    });

    const result = await submitter.submit({
      packageHash: 'a'.repeat(64),
      entryPoint: 'anchor_decision',
      args: { decision_id: 'cgd_1', decision_hash: 'sha256:abc' },
    });

    expect(result.txHash).toBe('real-tx-hash');
    expect(putTransactionSpy).toHaveBeenCalledTimes(1);
    expect(putDeploySpy).not.toHaveBeenCalled();
  });
});

describe('buildCasperGuardDeps odra wiring', () => {
  const SCHEMA_MIN = {
    DATABASE_URL: 'postgres://x:y@localhost:5432/z',
    REDIS_URL: 'redis://localhost:6379',
    ARC_RPC_URL: 'https://rpc.example',
    ARC_CHAIN_ID: '5042002',
    ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
    GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  };

  it('stays honest-blocked when odra package hash / rpc are not set', () => {
    const env = loadEnv(SCHEMA_MIN);
    const deps = buildCasperGuardDeps(env);
    expect(deps.odra?.configured).toBe(false);
    expect(deps.anchorer).toBeUndefined();
  });

  it('wires a real anchorer and sets odra.configured=true when package hash + rpc are set', () => {
    const env = loadEnv({
      ...SCHEMA_MIN,
      CASPER_GUARD_ODRA_PACKAGE_HASH: 'e'.repeat(64),
      CASPER_GUARD_ODRA_RPC_URL: 'https://node.testnet.casper.network/rpc',
      CASPER_GUARD_SIGNER_PEM_PATH: '/tmp/key.pem',
    });
    const deps = buildCasperGuardDeps(env);
    expect(deps.odra?.configured).toBe(true);
    expect(typeof deps.anchorer?.anchorDecision).toBe('function');
  });
});
