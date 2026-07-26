import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';

/**
 * Regression guard for a whole CLASS of bug, not just one instance.
 *
 * `registerGraphBuilderRoutes` existed, was fully implemented, and was covered by passing unit
 * tests — but was never called in `app.ts`. Every request to
 * `POST /v1/graph-builder/prompt-to-graph` 404'd, so the entire prompt-to-graph feature was dead
 * in a build whose suite was green. Unit tests on a route module cannot catch that; only a check
 * that the module is actually mounted can.
 *
 * This asserts that every `register*Route(s)` factory exported anywhere under `src/engines/` is
 * referenced by `src/app.ts`. It is deliberately static (no Postgres/Redis) so it runs in every
 * environment — the Docker-gated integration tests skip silently when infra is absent, which is
 * exactly how the original bug slipped through.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '../../../src');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('route registration completeness', () => {
  const appSource = readFileSync(path.join(srcRoot, 'app.ts'), 'utf8');

  it('mounts the graph-builder routes (prompt-to-graph would 404 otherwise)', () => {
    expect(appSource).toMatch(/registerGraphBuilderRoutes\(app\)/);
  });

  it('mounts every register*Route(s) factory exported under src/engines/', () => {
    const exported = new Map<string, string>(); // factory name -> defining file

    for (const file of walkTsFiles(path.join(srcRoot, 'engines'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/export function (register\w*Routes?)\s*\(/g)) {
        exported.set(match[1]!, path.relative(srcRoot, file));
      }
    }

    // Sanity: the scan itself must be finding things, or this test passes vacuously.
    expect(exported.size).toBeGreaterThan(5);

    const unmounted = [...exported.entries()]
      .filter(([name]) => !new RegExp(`\\b${name}\\(`).test(appSource))
      .map(([name, file]) => `${name} (defined in ${file})`);

    expect(unmounted, `route factories never called in app.ts: ${unmounted.join(', ')}`).toEqual([]);
  });

  /**
   * The end-to-end proof: build the real Fastify instance and confirm the path resolves. Route
   * registration touches neither Postgres nor Redis, so stub handles are enough — which keeps this
   * out of the Docker-gated set that skips silently when infra is absent.
   */
  it('resolves POST /v1/graph-builder/prompt-to-graph on a real Fastify instance', async () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: 'postgres://stub/stub',
      REDIS_URL: 'redis://stub:6379',
      GEMINI_API_KEY: 'test-key',
    } as NodeJS.ProcessEnv);
    const app = buildApp({ env, pg: {} as never, redis: {} as never });
    await app.ready();

    try {
      expect(app.printRoutes({ commonPrefix: false })).toContain('prompt-to-graph');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/graph-builder/prompt-to-graph',
        payload: { prompt: 'solo swapper' },
      });

      // 401 = mounted and auth-guarded. 404 = the original bug (module never registered).
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  }, 30_000);

  /**
   * J.1 — the same guard for Deploy. Deploy is the one builder route with real-world effects, so
   * an unmounted Deploy would present as "the visual builder doesn't deploy" — precisely the
   * symptom that motivated Milestone J. Assert it resolves and is auth-guarded.
   */
  it('resolves the J.1 deploy + graph-persistence routes on a real Fastify instance', async () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: 'postgres://stub/stub',
      REDIS_URL: 'redis://stub:6379',
      GEMINI_API_KEY: 'test-key',
    } as NodeJS.ProcessEnv);
    const app = buildApp({ env, pg: {} as never, redis: {} as never });
    await app.ready();

    try {
      for (const [method, url] of [
        ['POST', '/v1/graph-builder/deploy'],
        ['POST', '/v1/graph-builder/validate'],
        ['POST', '/v1/graph-builder/graphs'],
        ['GET', '/v1/graph-builder/graphs'],
      ] as const) {
        const res = await app.inject({ method, url, payload: { name: 'x', graph: { nodes: [], edges: [] } } });
        expect(res.statusCode, `${method} ${url} should be mounted`).not.toBe(404);
        expect(res.statusCode, `${method} ${url} should be auth-guarded`).toBe(401);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});
