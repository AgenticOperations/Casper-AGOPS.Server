import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createPgPool } from './db/client.js';
import { createRedis } from './redis/client.js';
import { buildApp } from './app.js';
import { createCasperTreasuryClient } from './lib/casper/treasury-client.js';

/**
 * Resolve a signer PEM to a filesystem path from EITHER a path OR a base64-encoded inline value.
 * Production (Railway) has no local PEM files, so the operator key is provided as *_PEM_INLINE; we
 * decode it to a 0600 temp file and hand that path to the treasury client. Path wins when both are set.
 * (Mirrors resolveSlotPemPath in config/casper-guard.ts, which the guard signer already uses.)
 */
function resolvePemPath(pemPath: string, pemInline: string, tmpFileName: string): string {
  if (pemPath !== '') return pemPath;
  if (pemInline !== '') {
    const tmpPath = join(tmpdir(), tmpFileName);
    writeFileSync(tmpPath, Buffer.from(pemInline, 'base64').toString('utf8'), { mode: 0o600 });
    return tmpPath;
  }
  return '';
}
import { buildCasperGuardDeps } from './config/casper-guard.js';
import { EncryptedStoreVault } from './engines/custody/key-vault.js';
import { createPgVaultBlobStore } from './engines/custody/pg-vault-blob-store.js';
import { sweepPendingConfirmations } from './engines/provisioning/confirm-sweep.js';
import { startConfirmationWorker } from './engines/provisioning/confirm-worker.js';
import { buildAgentFundingDeps } from './config/agent-funding.js';

/** Background sweep cadence; provides the natural "awaiting finality" window (MVP stub always-final). */
const CONFIRM_WORKER_INTERVAL_MS = 2000;

/**
 * Process entrypoint: validate env, wire the hot/cold stores, start listening, and
 * shut down cleanly. Any boot failure exits non-zero rather than serving in a
 * half-configured state (fail-fast).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const pgPool = createPgPool(env);
  const redis = createRedis(env);

  // Testnet treasury gateway (the default; reads the testnet operator account on the testnet RPC).
  const testnetPemPath = resolvePemPath(
    env.CASPER_GUARD_SIGNER_PEM_PATH,
    env.CASPER_GUARD_SIGNER_PEM_INLINE,
    'casper_guard_treasury_signer_testnet.pem',
  );
  const gateway = createCasperTreasuryClient({
    rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL || env.CASPER_GUARD_ODRA_RPC_URL,
    operatorAccountHash: env.CASPER_OPERATOR_ACCOUNT_HASH,
    pemPath: testnetPemPath,
    algorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
  });

  // Mainnet treasury gateway — only when the mainnet operator + RPC are configured. Reads the mainnet
  // operator account on the mainnet RPC and signs transfers with the mainnet key. Omitted otherwise so
  // the mainnet toggle's /v1/treasury/* calls 503 network_not_configured instead of silently showing
  // testnet balances.
  const mainnetRpc = env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL || env.CASPER_GUARD_MAINNET_ODRA_RPC_URL;
  const mainnetPemPath =
    resolvePemPath(
      env.CASPER_GUARD_MAINNET_SIGNER_PEM_PATH,
      env.CASPER_GUARD_MAINNET_SIGNER_PEM_INLINE,
      'casper_guard_treasury_signer_mainnet.pem',
    ) || testnetPemPath;
  const mainnetGateway =
    mainnetRpc && env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH
      ? createCasperTreasuryClient({
          rpcUrl: mainnetRpc,
          operatorAccountHash: env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH,
          pemPath: mainnetPemPath,
          algorithm: env.CASPER_GUARD_MAINNET_SIGNER_ALGORITHM,
        })
      : undefined;

  const gatewayByNetwork = {
    'casper:casper-test': gateway,
    ...(mainnetGateway ? { 'casper:casper': mainnetGateway } : {}),
  } as const;

  // Build the per-agent delegated-key vault ONCE (mirrors the exact gating in casper-guard.ts) and
  // share it with both AppDeps.vault (agent-create auto-grant) and buildCasperGuardDeps (runtime
  // signer). Absent when CASPER_GUARD_VAULT_MASTER_SECRET is unset → agents stay custodial.
  const vault =
    env.CASPER_GUARD_VAULT_MASTER_SECRET !== ''
      ? new EncryptedStoreVault({
          masterSecretHex: env.CASPER_GUARD_VAULT_MASTER_SECRET,
          store: createPgVaultBlobStore(pgPool),
        })
      : undefined;

  /*
   * JIT on-chain agent funding, built PER NETWORK. Each slot carries its own RPC, operator account,
   * WCSPR package hash, signing key and chain name — a single shared instance meant a mainnet
   * top-up was signed with the testnet chain name and rejected by every mainnet node
   * (`-32016 Invalid transaction: invalid chain name`). Either slot may be undefined when that
   * network is not fully configured; the treasury route then skips on-chain funding for it.
   */
  const buildFundingSlot = async (
    pem: string,
    network: 'casper:casper-test' | 'casper:casper',
  ) => {
    try {
      return await buildAgentFundingDeps(env, pem, network);
    } catch (err) {
      // Never block boot on funding wiring — fall back to the float-only path for that network.
      // eslint-disable-next-line no-console
      console.warn(`agent funding deps unavailable for ${network}, funding disabled:`, err);
      return undefined;
    }
  };
  const agentFunding = await buildFundingSlot(testnetPemPath, 'casper:casper-test');
  const agentFundingByNetwork = {
    'casper:casper-test': agentFunding,
    'casper:casper': await buildFundingSlot(mainnetPemPath, 'casper:casper'),
  };

  const app = buildApp({
    env,
    pg: pgPool,
    redis,
    gateway,
    gatewayByNetwork,
    ...(vault ? { vault } : {}),
    ...(agentFunding ? { agentFunding } : {}),
    agentFundingByNetwork,
    casperGuard: buildCasperGuardDeps(env, { pool: pgPool, ...(vault ? { vault } : {}) }),
  });

  const worker = startConfirmationWorker(
    { now: () => Math.floor(Date.now() / 1000) },
    {
      intervalMs: CONFIRM_WORKER_INTERVAL_MS,
      sweep: ({ now }) => sweepPendingConfirmations({ pool: pgPool, redis, gateway }, { now }),
      onError: (err) => app.log.warn({ err }, 'confirmation worker tick failed'),
    },
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    worker.stop();
    await app.close();
    await Promise.allSettled([pgPool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal: server failed to start', err);
  process.exit(1);
});
