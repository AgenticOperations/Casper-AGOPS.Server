import { describe, it, expect } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';

/**
 * `POST /v1/agents/:id/provision-delegated-key` — the repair path for an agent that has no
 * delegated keypair.
 *
 * Why it exists: agents can reach a state where every on-chain grant attempt answers
 * `no_delegated_key` with no way out — created while no vault was configured, created by a graph
 * deploy that skipped provisioning, or left keyless by a vault outage. Before this route the
 * product had no way to give such an agent a key; the only "fix" was to abandon it.
 *
 * Deliberately NOT Docker-gated. The Postgres-backed delegation route tests skip silently when
 * Docker is unavailable, so a route that regressed to 404 would look green — the same class of
 * bug that left the graph-builder routes unmounted and unnoticed.
 */
function app() {
  const env = loadEnv({
    ...process.env,
    DATABASE_URL: 'postgres://stub/stub',
    REDIS_URL: 'redis://stub:6379',
  } as NodeJS.ProcessEnv);
  return buildApp({ env, pg: {} as never, redis: {} as never });
}

describe('POST /v1/agents/:id/provision-delegated-key', () => {
  it('is mounted and auth-guarded (404 here would mean the repair path does not exist)', async () => {
    const instance = app();
    await instance.ready();
    try {
      const res = await instance.inject({
        method: 'POST',
        url: '/v1/agents/agt_test/provision-delegated-key',
        payload: {},
      });
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(401);
    } finally {
      await instance.close();
    }
  }, 30_000);

  it('is registered on the real route table', async () => {
    const instance = app();
    await instance.ready();
    try {
      expect(instance.printRoutes({ commonPrefix: false })).toContain('provision-delegated-key');
    } finally {
      await instance.close();
    }
  }, 30_000);
});
