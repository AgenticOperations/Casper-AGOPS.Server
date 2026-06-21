import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  type IdStores,
} from '../helpers/identity-harness.js';
import { checkRateLimit } from '../../src/lib/rate-limit.js';
import { newApiKeyId } from '../../src/lib/ids.js';

let stores: IdStores | null = null;
let app: FastifyInstance | undefined;
// Tight window for a fast deterministic route test.
beforeAll(async () => {
  stores = await startIdStores();
  if (stores) {
    ({ app } = buildIdApp(stores.pool, stores.redis, {
      AUTH_RATE_LIMIT: '3',
      AUTH_RATE_WINDOW_SECONDS: '60',
    }));
  }
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stopIdStores(stores);
});

describe('checkRateLimit (fixed-window math)', () => {
  it('counts allowed requests and reports remaining, then throttles past the limit', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const key = `test:ratelimit:${newApiKeyId()}`;
    const opts = { limit: 3, windowSeconds: 60 };
    const a = await checkRateLimit(stores.redis, key, opts);
    const b = await checkRateLimit(stores.redis, key, opts);
    const c = await checkRateLimit(stores.redis, key, opts);
    const d = await checkRateLimit(stores.redis, key, opts);
    expect(a).toMatchObject({ allowed: true, remaining: 2 });
    expect(b).toMatchObject({ allowed: true, remaining: 1 });
    expect(c).toMatchObject({ allowed: true, remaining: 0 });
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    expect(d.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('a different key is independent', async ({ skip }) => {
    if (!stores) return skip();
    const opts = { limit: 1, windowSeconds: 60 };
    const k1 = `test:ratelimit:${newApiKeyId()}`;
    const k2 = `test:ratelimit:${newApiKeyId()}`;
    expect((await checkRateLimit(stores.redis, k1, opts)).allowed).toBe(true);
    expect((await checkRateLimit(stores.redis, k1, opts)).allowed).toBe(false);
    // Fresh key still has its full budget.
    expect((await checkRateLimit(stores.redis, k2, opts)).allowed).toBe(true);
  });

  it('resets after the window elapses (tiny 1s window)', async ({ skip }) => {
    if (!stores) return skip();
    const key = `test:ratelimit:${newApiKeyId()}`;
    const opts = { limit: 1, windowSeconds: 1 };
    expect((await checkRateLimit(stores.redis, key, opts)).allowed).toBe(true);
    expect((await checkRateLimit(stores.redis, key, opts)).allowed).toBe(false);
    // Wait out the 1s window (+ margin), then the counter resets and the next hit is allowed again.
    await new Promise((r) => setTimeout(r, 1300));
    expect((await checkRateLimit(stores.redis, key, opts)).allowed).toBe(true);
  });
});

describe('auth rate limiting (per-IP, on the route)', () => {
  it('returns 429 after the per-IP login limit is exceeded', async ({ skip }) => {
    if (!stores || !app) return skip();
    const ip = '203.0.113.7';
    const hit = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { email: 'rl@test.com', password: 'whatever-strong' },
      });
    // Limit = 3: first 3 are processed (401 invalid creds), the 4th is throttled.
    await hit();
    await hit();
    await hit();
    const throttled = await hit();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json<{ error: string }>().error).toBe('rate_limited');
    expect(throttled.headers['retry-after']).toBeDefined();
  });

  it('a different IP is not affected (per-IP keying)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': '198.51.100.9' },
      payload: { email: 'other@test.com', password: 'whatever-strong' },
    });
    expect(res.statusCode).toBe(401); // processed, not throttled
  });

  it('register is throttled independently of login (separate route-group)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const ip = '203.0.113.50';
    const hit = (email: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { 'x-forwarded-for': ip },
        payload: { email, password: 'hunter2-strong', name: 'D' },
      });
    await hit('rg1@test.com');
    await hit('rg2@test.com');
    await hit('rg3@test.com');
    const throttled = await hit('rg4@test.com');
    expect(throttled.statusCode).toBe(429);
    // The SAME ip on login still has its own budget (independent route-group counter).
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email: 'rg1@test.com', password: 'hunter2-strong' },
    });
    expect(login.statusCode).not.toBe(429);
  });

  it('throttles request-password-reset per IP', async ({ skip }) => {
    if (!stores || !app) return skip();
    const ip = '203.0.113.77';
    const hit = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/auth/request-password-reset',
        headers: { 'x-forwarded-for': ip },
        payload: { email: 'reset@test.com' },
      });
    await hit();
    await hit();
    await hit();
    const throttled = await hit();
    expect(throttled.statusCode).toBe(429);
  });
});
