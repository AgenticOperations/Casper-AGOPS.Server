import { loadEnv } from './config/env.js';
import { createPgPool } from './db/client.js';
import { createRedis } from './redis/client.js';
import { buildApp } from './app.js';
import { createCasperTreasuryClient } from './lib/casper/treasury-client.js';
import { buildCasperGuardDeps } from './config/casper-guard.js';
import { sweepPendingConfirmations } from './engines/provisioning/confirm-sweep.js';
import { startConfirmationWorker } from './engines/provisioning/confirm-worker.js';

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
  const gateway = createCasperTreasuryClient({
    rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL || env.CASPER_GUARD_ODRA_RPC_URL,
    operatorAccountHash: env.CASPER_OPERATOR_ACCOUNT_HASH,
    pemPath: env.CASPER_GUARD_SIGNER_PEM_PATH,
    algorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
  });

  // Mainnet treasury gateway — only when the mainnet operator + RPC are configured. Reads the mainnet
  // operator account on the mainnet RPC and signs transfers with the mainnet key. Omitted otherwise so
  // the mainnet toggle's /v1/treasury/* calls 503 network_not_configured instead of silently showing
  // testnet balances.
  const mainnetRpc = env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL || env.CASPER_GUARD_MAINNET_ODRA_RPC_URL;
  const mainnetGateway =
    mainnetRpc && env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH
      ? createCasperTreasuryClient({
          rpcUrl: mainnetRpc,
          operatorAccountHash: env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH,
          pemPath: env.CASPER_GUARD_MAINNET_SIGNER_PEM_PATH || env.CASPER_GUARD_SIGNER_PEM_PATH,
          algorithm: env.CASPER_GUARD_MAINNET_SIGNER_ALGORITHM,
        })
      : undefined;

  const gatewayByNetwork = {
    'casper:casper-test': gateway,
    ...(mainnetGateway ? { 'casper:casper': mainnetGateway } : {}),
  } as const;

  const app = buildApp({
    env,
    pg: pgPool,
    redis,
    gateway,
    gatewayByNetwork,
    casperGuard: buildCasperGuardDeps(env, { pool: pgPool }),
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
