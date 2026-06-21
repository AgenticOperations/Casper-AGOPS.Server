import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { startIdStores, stopIdStores, type IdStores } from '../helpers/identity-harness.js';
import {
  createGoogleClient,
  type GoogleClient,
  type GoogleProfile,
} from '../../src/engines/identity/oauth/google.js';
import { createUser, findUserByEmail } from '../../src/engines/identity/account/user-store.js';

/**
 * Google OAuth (OIDC authorization-code) coverage. The GoogleClient seam is INJECTED as a fake so no
 * test ever hits the network. We assert: the credential gate (501 when unconfigured), the CSRF state
 * check (403 on mismatch + cleared cookie), the happy-path upsert (new user + oauth link + session +
 * cleared state cookie), the returning-user path (same user, new session), and — security-critical —
 * the account-takeover guard: an UNVERIFIED google email must NOT auto-link to an existing password user.
 */

const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  ARC_RPC_URL: 'https://rpc.example',
  ARC_CHAIN_ID: '421614',
  ARC_USDC_ADDRESS: '0x5555555555555555555555555555555555555555',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

const CONFIGURED_ENV = {
  ...BASE_ENV,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REDIRECT_URL: 'http://localhost:8080/v1/auth/google/callback',
};

function appWithGoogle(pool: pg.Pool, redis: Redis, google: GoogleClient): FastifyInstance {
  const env = loadEnv(CONFIGURED_ENV);
  return buildApp({ env, pg: pool, redis, googleOAuth: google });
}

/**
 * A fake Google client. `authUrl(state)` bakes the state into a Google-looking URL; `exchange(code)`
 * resolves to a profile derived from the code, so each test can steer the resulting identity by varying
 * the code. A per-test `profileFor` override lets a test pin email/email_verified/sub precisely.
 */
function fakeGoogle(profileFor?: (code: string) => GoogleProfile): GoogleClient {
  return {
    configured: true,
    authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    exchange: (code) =>
      Promise.resolve(
        profileFor
          ? profileFor(code)
          : { sub: `g-${code}`, email: `oauth-${code}@gmail.com`, emailVerified: true, name: 'G User' },
      ),
  };
}

/**
 * A fake `fetch` that scripts the live GoogleClient's two-hop exchange: the token POST then the
 * userinfo GET. `userinfo` is the RAW JSON body Google would return — deliberately typed loosely so a
 * test can plant a NON-boolean `email_verified` (Google's OIDC userinfo has historically returned the
 * STRING "false"/"true"). This proves the boundary coercion in google.ts, not a pre-typed fake.
 */
function fakeFetch(userinfo: Record<string, unknown>): typeof fetch {
  const impl = (input: string | URL | Request): Promise<unknown> => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = href.includes('/token') ? { access_token: 'at-test' } : userinfo;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return impl as unknown as typeof fetch;
}

/** Drive start→callback with a fresh app, returning the callback reply. */
async function startThenCallback(
  app: FastifyInstance,
  code: string,
): Promise<import('light-my-request').Response> {
  const start = await app.inject({ method: 'GET', url: '/v1/auth/google/start' });
  const stateCookie = String(start.headers['set-cookie']);
  const state = /agentops_oauth_state=([^;]+)/.exec(stateCookie)![1];
  return app.inject({
    method: 'GET',
    url: `/v1/auth/google/callback?code=${code}&state=${state}`,
    headers: { cookie: `agentops_oauth_state=${state}` },
  });
}

let stores: IdStores | null = null;
beforeAll(async () => {
  stores = await startIdStores();
}, 180_000);
afterAll(async () => {
  await stopIdStores(stores);
});

describe('Google OAuth', () => {
  it('start redirects to Google with a state cookie set', async ({ skip }) => {
    if (!stores) return skip();
    const app = appWithGoogle(stores.pool, stores.redis, fakeGoogle());
    const res = await app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/agentops_oauth_state=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    await app.close();
  });

  it('callback (new user) exchanges code, upserts user + oauth link, sets a session, clears state, redirects', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const app = appWithGoogle(stores.pool, stores.redis, fakeGoogle());
    const cb = await startThenCallback(app, 'newuser1');
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toMatch(/^http:\/\/localhost:3000/);

    const setCookies = Array.isArray(cb.headers['set-cookie'])
      ? cb.headers['set-cookie']
      : [String(cb.headers['set-cookie'])];
    const joined = setCookies.join('|');
    // BOTH the session cookie AND the cleared state cookie must be present (array of Set-Cookie strings).
    expect(joined).toMatch(/agentops_session=/);
    expect(joined).toMatch(/agentops_oauth_state=;|agentops_oauth_state=; /);
    expect(joined).toMatch(/Max-Age=0/);

    const user = await stores.pool.query<{ id: string; email_verified: boolean }>(
      "SELECT id, email_verified FROM users WHERE email = 'oauth-newuser1@gmail.com'",
    );
    expect(user.rowCount).toBe(1);
    expect(user.rows[0]?.email_verified).toBe(true);
    const link = await stores.pool.query<{ user_id: string }>(
      "SELECT user_id FROM oauth_accounts WHERE provider='google' AND provider_account_id='g-newuser1'",
    );
    expect(link.rowCount).toBe(1);
    expect(link.rows[0]?.user_id).toBe(user.rows[0]?.id);
    const sess = await stores.pool.query('SELECT id FROM sessions WHERE user_id = $1', [
      user.rows[0]?.id,
    ]);
    expect(sess.rowCount).toBe(1);
    await app.close();
  });

  it('callback (returning user via existing oauth_accounts) reuses the same user, mints a new session', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const app = appWithGoogle(stores.pool, stores.redis, fakeGoogle());
    // First sign-in creates the user.
    const first = await startThenCallback(app, 'return1');
    expect(first.statusCode).toBe(302);
    const user = await stores.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email='oauth-return1@gmail.com'",
    );
    const userId = user.rows[0]?.id;

    // Second sign-in with the SAME google sub must reuse the user (no duplicate user / oauth row).
    const second = await startThenCallback(app, 'return1');
    expect(second.statusCode).toBe(302);

    const users = await stores.pool.query(
      "SELECT id FROM users WHERE email='oauth-return1@gmail.com'",
    );
    expect(users.rowCount).toBe(1);
    const links = await stores.pool.query(
      "SELECT id FROM oauth_accounts WHERE provider='google' AND provider_account_id='g-return1'",
    );
    expect(links.rowCount).toBe(1);
    const sessions = await stores.pool.query('SELECT id FROM sessions WHERE user_id = $1', [userId]);
    expect(sessions.rowCount).toBe(2); // two sign-ins → two sessions
    await app.close();
  });

  it('callback (existing email + google email_verified=TRUE) links the google identity to the existing user', async ({
    skip,
  }) => {
    if (!stores) return skip();
    // Pre-existing PASSWORD user.
    const existing = await createUser(stores.pool, {
      email: 'verified-link@test.com',
      passwordHash: 'scrypt$x',
      emailVerified: false,
      name: 'PW User',
    });
    const app = appWithGoogle(
      stores.pool,
      stores.redis,
      fakeGoogle(() => ({
        sub: 'g-verified-link',
        email: 'verified-link@test.com',
        emailVerified: true,
        name: 'G',
      })),
    );
    const cb = await startThenCallback(app, 'verified-link');
    expect(cb.statusCode).toBe(302);

    // Same user — the google account is LINKED, not a new user.
    const link = await stores.pool.query<{ user_id: string }>(
      "SELECT user_id FROM oauth_accounts WHERE provider='google' AND provider_account_id='g-verified-link'",
    );
    expect(link.rowCount).toBe(1);
    expect(link.rows[0]?.user_id).toBe(existing.id);
    // Google's verified email upgrades the existing user's email_verified.
    const u = await findUserByEmail(stores.pool, 'verified-link@test.com');
    expect(u!.emailVerified).toBe(true);
    const userCount = await stores.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE email='verified-link@test.com'",
    );
    expect(userCount.rows[0]?.n).toBe(1);
    await app.close();
  });

  it('callback (existing email + google email_verified=FALSE) does NOT link to the existing password user (takeover guard)', async ({
    skip,
  }) => {
    if (!stores) return skip();
    // Pre-existing PASSWORD user with this email.
    const existing = await createUser(stores.pool, {
      email: 'takeover@test.com',
      passwordHash: 'scrypt$x',
      emailVerified: true,
      name: 'Victim',
    });
    const app = appWithGoogle(
      stores.pool,
      stores.redis,
      fakeGoogle(() => ({
        sub: 'g-takeover',
        email: 'takeover@test.com',
        emailVerified: false, // UNVERIFIED google email — must not seize the existing account
        name: 'Attacker',
      })),
    );
    const cb = await startThenCallback(app, 'takeover');

    // No oauth link may point at the victim's user id (never auto-link an unverified email).
    const linkedToVictim = await stores.pool.query(
      "SELECT 1 FROM oauth_accounts WHERE provider='google' AND provider_account_id='g-takeover' AND user_id=$1",
      [existing.id],
    );
    expect(linkedToVictim.rowCount).toBe(0);
    // The victim's account is untouched (still a password account, no oauth rows attached to it).
    const victimOauth = await stores.pool.query(
      'SELECT 1 FROM oauth_accounts WHERE user_id=$1',
      [existing.id],
    );
    expect(victimOauth.rowCount).toBe(0);
    // The flow fails closed: no session for the victim was created.
    const victimSessions = await stores.pool.query('SELECT 1 FROM sessions WHERE user_id=$1', [
      existing.id,
    ]);
    expect(victimSessions.rowCount).toBe(0);
    // It must NOT be a 302 that drops the attacker into the app as the victim.
    expect(cb.statusCode).not.toBe(302);
    await app.close();
  });

  it('callback with mismatched state is rejected (CSRF) → 403 and clears the state cookie', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const app = appWithGoogle(stores.pool, stores.redis, fakeGoogle());
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=abc&state=evil',
      headers: { cookie: 'agentops_oauth_state=different' },
    });
    expect(res.statusCode).toBe(403);
    // The bad state cookie is cleared on rejection.
    expect(String(res.headers['set-cookie'] ?? '')).toMatch(/agentops_oauth_state=;/);
    await app.close();
  });

  it('callback with a missing state cookie is rejected → 403', async ({ skip }) => {
    if (!stores) return skip();
    const app = appWithGoogle(stores.pool, stores.redis, fakeGoogle());
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=abc&state=anything',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('callback fails closed on exchange error → 502, no session, clears state cookie', async ({
    skip,
  }) => {
    if (!stores) return skip();
    // A fake whose exchange REJECTS (token/userinfo error). The route must NOT mint a session.
    const throwingGoogle: GoogleClient = {
      configured: true,
      authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchange: () => Promise.reject(new Error('google_token_exchange_failed_400')),
    };
    const app = appWithGoogle(stores.pool, stores.redis, throwingGoogle);
    const cb = await startThenCallback(app, 'boom');
    // Fail closed: 502, never a 302 into the app.
    expect(cb.statusCode).toBe(502);
    expect(cb.json<{ error: string }>().error).toBe('google_exchange_failed');
    // The state cookie is cleared on the way out.
    const setCookie = String(cb.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/agentops_oauth_state=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
    // No session cookie is set.
    expect(setCookie).not.toMatch(/agentops_session=/);
    await app.close();
  });

  it('when unconfigured, start + callback return 501 (not a crash)', async ({ skip }) => {
    if (!stores) return skip();
    const env = loadEnv(BASE_ENV); // no GOOGLE_* → configured:false
    const app = buildApp({ env, pg: stores.pool, redis: stores.redis });
    const start = await app.inject({ method: 'GET', url: '/v1/auth/google/start' });
    expect(start.statusCode).toBe(501);
    expect(start.json<{ error: string }>().error).toBe('google_oauth_not_configured');
    const cb = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=x&state=y',
    });
    expect(cb.statusCode).toBe(501);
    expect(cb.json<{ error: string }>().error).toBe('google_oauth_not_configured');
    await app.close();
  });
});

/**
 * Boundary coercion of the RAW Google userinfo body (no DB, no network). Google's OIDC userinfo has
 * historically returned `email_verified` as a STRING ("false"/"true") rather than a JSON boolean. The
 * parser MUST treat emailVerified as TRUE only for a real boolean `true` — never the string "true",
 * and never a truthy string "false". Anything else is account-takeover bait downstream.
 */
describe('Google userinfo email_verified coercion (boundary)', () => {
  const cfg = { clientId: 'id', clientSecret: 'secret', redirectUrl: 'http://localhost/cb' };

  it('STRING "false" → emailVerified === false (the account-takeover regression)', async () => {
    const client = createGoogleClient(
      cfg,
      fakeFetch({ sub: 'g-1', email: 'x@test.com', email_verified: 'false', name: 'X' }),
    );
    const profile = await client.exchange('code');
    expect(profile.emailVerified).toBe(false);
  });

  it('STRING "true" is NOT honored → emailVerified === false', async () => {
    const client = createGoogleClient(
      cfg,
      fakeFetch({ sub: 'g-2', email: 'y@test.com', email_verified: 'true', name: 'Y' }),
    );
    const profile = await client.exchange('code');
    expect(profile.emailVerified).toBe(false);
  });

  it('boolean true → emailVerified === true', async () => {
    const client = createGoogleClient(
      cfg,
      fakeFetch({ sub: 'g-3', email: 'z@test.com', email_verified: true, name: 'Z' }),
    );
    const profile = await client.exchange('code');
    expect(profile.emailVerified).toBe(true);
  });

  it('missing email_verified → emailVerified === false', async () => {
    const client = createGoogleClient(
      cfg,
      fakeFetch({ sub: 'g-4', email: 'w@test.com', name: 'W' }),
    );
    const profile = await client.exchange('code');
    expect(profile.emailVerified).toBe(false);
  });
});
