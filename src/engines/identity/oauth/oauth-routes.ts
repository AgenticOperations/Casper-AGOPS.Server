import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import {
  serializeCookie,
  serializeSessionCookie,
  parseCookies,
  type CookieOptions,
} from '../../../lib/cookies.js';
import { newOAuthState, sha256Hex } from './google.js';
import { upsertOAuthUser } from '../account/oauth-store.js';
import { createSession } from '../account/session-store.js';
import { sessionCookiePolicy } from '../account/auth-routes.js';

/**
 * Google sign-in routes (OIDC authorization-code). `start` redirects the browser to Google and pins an
 * opaque CSRF `state` in a short-lived httpOnly+SameSite=Lax cookie. `callback` re-checks the state,
 * exchanges the code via the INJECTED GoogleClient (no network in tests), upserts the user + oauth link
 * (with the account-takeover guard in oauth-store), mints a session, and redirects into the app.
 *
 * Credential gate: when `app.deps.googleOAuth` is absent or `configured:false`, both routes answer
 * 501 `{error:'google_oauth_not_configured'}` — a clean "feature off", never a crash. Email+password
 * auth is entirely unaffected by the absence of Google credentials.
 *
 * Fail-closed: a state mismatch, a token-exchange error, or an unverified-email link conflict all result
 * in NO session being created and a clean 4xx/5xx (never a 302 that drops an attacker into the app).
 */
const STATE_COOKIE = 'agentops_oauth_state';
const STATE_TTL_SECONDS = 600; // 10 minutes — the cookie only needs to survive the redirect round-trip.

/** Short-lived httpOnly+SameSite=Lax options for the CSRF state cookie. `secure` only in production. */
function stateCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAgeSeconds: STATE_TTL_SECONDS };
}

/** The cleared state cookie (Max-Age=0, same attributes) — set on both success and CSRF rejection. */
function clearedStateCookie(secure: boolean): string {
  return serializeCookie(STATE_COOKIE, '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAgeSeconds: 0 });
}

/** Constant-time equality of two CSRF states (compares their sha256 hashes — equal length, no early-exit). */
function statesMatch(a: string, b: string): boolean {
  const ah = Buffer.from(sha256Hex(a), 'hex');
  const bh = Buffer.from(sha256Hex(b), 'hex');
  // sha256 hashes are always 32 bytes, so the length check is a formality, but keep it for safety.
  if (ah.length !== bh.length) return false;
  return timingSafeEqual(ah, bh);
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  app.get('/v1/auth/google/start', async (_request, reply) => {
    const google = app.deps.googleOAuth;
    if (!google || !google.configured) {
      return reply.code(501).send({ error: 'google_oauth_not_configured' });
    }
    const secure = app.deps.env.NODE_ENV === 'production';
    const state = newOAuthState();
    reply.header('set-cookie', serializeCookie(STATE_COOKIE, state, stateCookieOptions(secure)));
    return reply.redirect(google.authUrl(state), 302);
  });

  app.get('/v1/auth/google/callback', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const google = app.deps.googleOAuth;
    if (!google || !google.configured) {
      return reply.code(501).send({ error: 'google_oauth_not_configured' });
    }
    const secure = env.NODE_ENV === 'production';

    const { code, state } = request.query as { code?: string; state?: string };
    const cookieState = parseCookies(request.headers.cookie)[STATE_COOKIE];
    // CSRF: the state echoed by Google must equal the one we pinned in the cookie. Missing either side,
    // or a mismatch, is rejected 403 — and we clear the (stale/forged) state cookie on the way out.
    if (!code || !state || !cookieState || !statesMatch(state, cookieState)) {
      reply.header('set-cookie', clearedStateCookie(secure));
      return reply.code(403).send({ error: 'oauth_state_mismatch' });
    }

    let profile;
    try {
      profile = await google.exchange(code);
    } catch {
      // Fail closed: any token-exchange / userinfo error → no session, clear the state cookie, 502.
      // The error message (which only carries an opaque status code, never a secret) is NOT echoed.
      reply.header('set-cookie', clearedStateCookie(secure));
      return reply.code(502).send({ error: 'google_exchange_failed' });
    }

    const result = await upsertOAuthUser(pool, {
      provider: 'google',
      providerAccountId: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
    });
    if (!result.ok) {
      // Account-takeover guard tripped (unverified Google email collides with an existing account).
      // No session is minted; clear the state cookie and refuse with 403.
      reply.header('set-cookie', clearedStateCookie(secure));
      return reply.code(403).send({ error: 'email_unverified_conflict' });
    }

    const { token } = await createSession(pool, result.user.id);
    // Set BOTH cookies in one response: Fastify REPLACES a repeated single-string set-cookie, so we pass
    // an ARRAY of serialized strings — the live session cookie AND the cleared one-time state cookie.
    reply.header('set-cookie', [
      serializeSessionCookie(token, sessionCookiePolicy(env)),
      clearedStateCookie(secure),
    ]);
    return reply.redirect(env.APP_BASE_URL, 302);
  });
}
