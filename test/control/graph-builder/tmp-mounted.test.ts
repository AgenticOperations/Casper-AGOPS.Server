import { describe, it, expect } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';

describe('graph-builder route is actually mounted on the Fastify instance', () => {
  it('registers POST /v1/graph-builder/prompt-to-graph', async () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: 'postgres://stub/stub',
      REDIS_URL: 'redis://stub:6379',
      GEMINI_API_KEY: 'test-key',
    } as NodeJS.ProcessEnv);
    const app = buildApp({ env, pg: {} as never, redis: {} as never });
    await app.ready();

    const table = app.printRoutes({ commonPrefix: false });
    console.log(table.split('\n').filter((l) => /graph|prompt/.test(l)).join('\n'));
    expect(table).toContain('prompt-to-graph');

    // Prove it responds (auth rejects, but a 404 would mean it was never mounted).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/graph-builder/prompt-to-graph',
      payload: { prompt: 'solo swapper' },
    });
    console.log('status:', res.statusCode, res.body.slice(0, 120));
    expect(res.statusCode).not.toBe(404);

    await app.close();
  }, 30_000);
});
