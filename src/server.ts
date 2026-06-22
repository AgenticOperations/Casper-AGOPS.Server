import { loadEnv } from './config/env.js';
import { createPgPool } from './db/client.js';
import { createRedis } from './redis/client.js';
import { buildApp } from './app.js';
import { GatewayClient } from './lib/circle/gateway.js';
import { createStubTransport } from './lib/circle/stub-transport.js';
import { createHttpTransport } from './lib/circle/http-transport.js';
import { buildHotPath } from './config/hotpath.js';
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

  // Honest, credential-gated Circle boundary: the REAL authenticated HTTP transport is selected ONLY on
  // an explicit opt-in (CIRCLE_GATEWAY_LIVE=true) AND a present key — so a key configured for other Circle
  // use cannot silently route treasury through Gateway before the on-chain Gateway protocol is integrated.
  // Otherwise we fall back to the always-final Redis stub. We NEVER silently pretend to be live. `mode` is
  // the only thing logged below — the key itself is never serialized. 'live' = real Circle HTTP; 'local' = stub.
  const circleLive = env.CIRCLE_GATEWAY_LIVE === 'true' && env.CIRCLE_API_KEY !== '';
  const gateway = new GatewayClient(
    circleLive
      ? createHttpTransport({ apiBase: env.CIRCLE_API_BASE, apiKey: env.CIRCLE_API_KEY })
      : createStubTransport(redis),
  );
  const app = buildApp({
    env,
    pg: pgPool,
    redis,
    gateway,
    hotPath: buildHotPath(env),
    casperGuard: buildCasperGuardDeps(env),
  });
  app.log.info({ mode: circleLive ? 'live' : 'local' }, 'circle gateway transport');

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
