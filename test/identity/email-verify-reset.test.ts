import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  sessionCookieFrom,
  type IdStores,
} from '../helpers/identity-harness.js';
import type { DevLogEmailTransport } from '../../src/lib/email/transport.js';
import { resolveSession } from '../../src/engines/identity/account/session-store.js';
import { issueEmailVerificationToken } from '../../src/engines/identity/account/token-store.js';

let stores: IdStores | null = null;
let app: FastifyInstance | undefined;
let email: DevLogEmailTransport | undefined;
beforeAll(async () => {
  stores = await startIdStores();
  if (stores) ({ app, email } = buildIdApp(stores.pool, stores.redis));
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stopIdStores(stores);
});

const tokenFromLink = (link: string): string => new URL(link).searchParams.get('token')!;
const tokenValue = (cookie: string): string => cookie.slice(cookie.indexOf('=') + 1);

describe('email verification', () => {
  it('register dispatches a verify link; POST /v1/auth/verify-email flips email_verified', async ({
    skip,
  }) => {
    if (!stores || !app || !email) return skip();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'verify@test.com', password: 'hunter2-strong' },
    });
    const msg = email.lastFor('verify@test.com', 'verify_email');
    expect(msg).toBeDefined();
    const token = tokenFromLink(msg!.link);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ email_verified: boolean }>().email_verified).toBe(true);

    // A second use of the same token is rejected (single-use).
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(again.statusCode).toBe(400);
  });

  it('an EXPIRED verify token is rejected → 400', async ({ skip }) => {
    if (!stores || !app) return skip();
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'expired-verify@test.com', password: 'hunter2-strong' },
    });
    const userId = reg.json<{ user: { id: string } }>().user.id;
    // Mint a token then force it expired in the DB.
    const token = await issueEmailVerificationToken(stores.pool, userId);
    await stores.pool.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
      [userId],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
  });

  it('login is allowed while unverified (dev: surface state, do not hard-block)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'unverified@test.com', password: 'hunter2-strong' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'unverified@test.com', password: 'hunter2-strong' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { email_verified: boolean } }>().user.email_verified).toBe(false);
  });
});

describe('password reset', () => {
  it('request → dispatch link → confirm sets a new password; old password fails, new works', async ({
    skip,
  }) => {
    if (!stores || !app || !email) return skip();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'reset@test.com', password: 'old-password-strong' },
    });

    const reqRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      payload: { email: 'reset@test.com' },
    });
    expect(reqRes.statusCode).toBe(202); // accepted (always 202, no user enumeration)
    const msg = email.lastFor('reset@test.com', 'password_reset');
    const token = tokenFromLink(msg!.link);

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'new-password-strong' },
    });
    expect(confirm.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'reset@test.com', password: 'old-password-strong' },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'reset@test.com', password: 'new-password-strong' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('a successful reset REVOKES all pre-existing sessions (stolen session cannot survive)', async ({
    skip,
  }) => {
    if (!stores || !app || !email) return skip();
    // Register → capture the live session cookie minted at registration.
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'revoke@test.com', password: 'old-password-strong' },
    });
    const preCookie = sessionCookieFrom(reg.headers['set-cookie']);
    expect(preCookie).toBeTruthy();
    // The pre-reset session resolves before the reset.
    expect(await resolveSession(stores.pool, tokenValue(preCookie!))).not.toBeNull();

    const reqRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      payload: { email: 'revoke@test.com' },
    });
    expect(reqRes.statusCode).toBe(202);
    const token = tokenFromLink(email.lastFor('revoke@test.com', 'password_reset')!.link);

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'new-password-strong' },
    });
    expect(confirm.statusCode).toBe(200);

    // The pre-reset session no longer resolves — invalidate-on-reset.
    expect(await resolveSession(stores.pool, tokenValue(preCookie!))).toBeNull();
  });

  it('an invalid reset token is rejected → 400', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: 'not-a-real-token', password: 'new-password-strong' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a USED reset token is rejected on reuse → 400', async ({ skip }) => {
    if (!stores || !app || !email) return skip();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'reuse-reset@test.com', password: 'old-password-strong' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      payload: { email: 'reuse-reset@test.com' },
    });
    const token = tokenFromLink(email.lastFor('reuse-reset@test.com', 'password_reset')!.link);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'new-password-strong' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'another-password-strong' },
    });
    expect(second.statusCode).toBe(400);
  });

  it('request for an UNKNOWN email still returns 202 (no enumeration) and dispatches nothing', async ({
    skip,
  }) => {
    if (!stores || !app || !email) return skip();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-password-reset',
      payload: { email: 'nobody@test.com' },
    });
    expect(res.statusCode).toBe(202);
    expect(email.lastFor('nobody@test.com', 'password_reset')).toBeUndefined();
  });
});
