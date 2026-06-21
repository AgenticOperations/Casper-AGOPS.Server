import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  sessionCookieFrom,
  type IdStores,
} from '../helpers/identity-harness.js';
import { resolveSession } from '../../src/engines/identity/account/session-store.js';

/** Pull the plaintext session token out of a `name=value` cookie string (for resolveSession checks). */
function tokenValue(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

let stores: IdStores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startIdStores();
  if (stores) app = buildIdApp(stores.pool, stores.redis).app;
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stopIdStores(stores);
});

const reg = (email: string) => ({
  method: 'POST' as const,
  url: '/v1/auth/register',
  payload: { email, password: 'hunter2-strong', name: 'Dev' },
});

describe('POST /v1/auth/register', () => {
  it('creates a user, sets an httpOnly session cookie, returns the user', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject(reg('reg@test.com'));
    expect(res.statusCode).toBe(201);
    const cookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(cookie) ? cookie.join('|') : String(cookie ?? '');
    expect(cookieStr).toMatch(/agentops_session=/);
    expect(cookieStr).toMatch(/HttpOnly/);
    expect(cookieStr).toMatch(/SameSite=Lax/);
    const body = res.json<{ user: { id: string; email: string; email_verified: boolean } }>();
    expect(body.user.email).toBe('reg@test.com');
    expect(body.user.email_verified).toBe(false);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async ({ skip }) => {
    if (!stores || !app) return skip();
    await app.inject(reg('dup@test.com'));
    const res = await app.inject(reg('DUP@test.com'));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('email_taken');
  });

  it('rejects a weak/short password with 400', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'weak@test.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/auth/login + logout', () => {
  it('logs in with correct credentials and sets a session cookie', async ({ skip }) => {
    if (!stores || !app) return skip();
    await app.inject(reg('login@test.com'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'login@test.com', password: 'hunter2-strong' },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookieFrom(res.headers['set-cookie'])).not.toBeNull();
  });

  it('rejects wrong password with 401 and NO cookie', async ({ skip }) => {
    if (!stores || !app) return skip();
    await app.inject(reg('wrongpw@test.com'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'wrongpw@test.com', password: 'nope-nope-nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCookieFrom(res.headers['set-cookie'])).toBeNull();
  });

  it('rejects an unknown email with 401 (same shape as wrong password — no user enumeration)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ghost@test.com', password: 'whatever-strong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('invalid_credentials');
  });

  it('logout returns 204 and emits a session-clearing cookie (Max-Age=0)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const r = await app.inject(reg('logout@test.com'));
    const cookie = sessionCookieFrom(r.headers['set-cookie'])!;
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const cleared = out.headers['set-cookie'];
    const clearedStr = Array.isArray(cleared) ? cleared.join('|') : String(cleared ?? '');
    expect(clearedStr).toMatch(/agentops_session=/);
    expect(clearedStr).toMatch(/Max-Age=0/);
  });

  // Proves logout truly revokes the session server-side WITHOUT needing GET /v1/me: the captured
  // plaintext token no longer resolves via resolveSession() once logout has run.
  it('logout revokes the session server-side (resolveSession returns null)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const r = await app.inject(reg('revoke@test.com'));
    const cookie = sessionCookieFrom(r.headers['set-cookie'])!;
    const token = tokenValue(cookie);
    // Live session resolves to a principal before logout.
    const before = await resolveSession(stores.pool, token);
    expect(before).not.toBeNull();

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);

    // Server-side guarantee: the same plaintext token no longer resolves (revoked_at is set).
    const after = await resolveSession(stores.pool, token);
    expect(after).toBeNull();
  });

  // P1d: GET /v1/me now exists. Proves logout truly revokes the session server-side
  // (the same cookie no longer resolves to a principal), not just that the cookie was cleared.
  it('logout revokes the session (the cookie no longer resolves on /v1/me)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const r = await app.inject(reg('logout2@test.com'));
    const cookie = sessionCookieFrom(r.headers['set-cookie'])!;
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(401); // session revoked
  });
});
