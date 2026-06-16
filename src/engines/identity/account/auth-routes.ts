import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Env } from '../../../config/env.js';
import { hashPassword, verifyPassword } from '../../../lib/password.js';
import { checkRateLimit } from '../../../lib/rate-limit.js';
import {
  parseCookies,
  serializeSessionCookie,
  serializeClearSessionCookie,
  type SessionCookiePolicy,
} from '../../../lib/cookies.js';
import { createUser, findUserByEmail } from './user-store.js';
import { createSession, revokeSession, SESSION_TTL_MS } from './session-store.js';
import { issueEmailVerificationToken } from './token-store.js';

/**
 * Email+password self-serve auth. Humans authenticate here and receive an httpOnly opaque-session cookie;
 * they NEVER receive an sk_ key (machine credentials are managed via the API-key routes). Login is
 * constant-shape for unknown-email vs wrong-password (no user enumeration). Secrets are never logged —
 * the request body (which carries the password) is never written to a log line.
 */

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  name: z.string().max(200).optional(),
});
const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

/** Postgres unique_violation. The users.email UNIQUE index is the real guard behind the pre-check. */
const PG_UNIQUE_VIOLATION = '23505';

/** Narrow an unknown error to a pg unique-violation without leaking its message. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Precomputed scrypt digest of a throwaway string, using the SAME params as {@link hashPassword}. Used
 * to equalize login timing: the unknown-email / no-password-hash branch pays a real scrypt verify
 * against this constant before returning 401, so it costs the same as a known-email-wrong-password
 * attempt (no timing-based user enumeration).
 */
const DUMMY_PASSWORD_DIGEST = hashPassword('agentops-timing-equalizer-throwaway');

/**
 * Derive the session-cookie policy from env. `secure` is on only in production (so dev/test over http
 * still receives the cookie); the cookie name + optional domain come from env.
 */
export function sessionCookiePolicy(env: Env): SessionCookiePolicy {
  return {
    name: env.SESSION_COOKIE_NAME,
    secure: env.NODE_ENV === 'production',
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/**
 * Set the live session Set-Cookie on the reply. Delegates to `serializeSessionCookie` so the SAME
 * serializer powers any caller that must set MULTIPLE Set-Cookie headers at once (P1h OAuth callback,
 * which passes an array — Fastify replaces a repeated single-string set-cookie).
 */
export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  const { env } = app.deps;
  reply.header('set-cookie', serializeSessionCookie(token, sessionCookiePolicy(env)));
}

function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  const { env } = app.deps;
  const { maxAgeSeconds: _unused, ...policy } = sessionCookiePolicy(env);
  void _unused;
  reply.header('set-cookie', serializeClearSessionCookie(policy));
}

/**
 * Per-IP fixed-window guard for an abuse-prone auth route group. Returns true if the request may
 * proceed; on the throttled path it has ALREADY sent the 429 (with a Retry-After header) and returns
 * false, so the caller must early-return without sending a second response.
 *
 * Keyed by client IP (the leftmost x-forwarded-for hop when present, else request.ip) + route group, so
 * login / register / reset each get an independent budget and one IP cannot exhaust another's.
 *
 * FAIL-OPEN: a Redis error (unavailable, misconfigured client) must NOT lock users out of auth — the
 * limiter is a guard, not the gate. We log a warning and allow the request through. (Exported so the
 * email routes reuse the exact same posture for the password-reset endpoints.)
 */
export async function authRateLimitOk(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  group: string,
): Promise<boolean> {
  const { redis, env } = app.deps;
  const forwarded = request.headers['x-forwarded-for'];
  const firstHop =
    typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim()
      : Array.isArray(forwarded)
        ? forwarded[0]?.split(',')[0]?.trim()
        : undefined;
  const ip = firstHop || request.ip;
  try {
    const result = await checkRateLimit(redis, `ratelimit:auth:${group}:${ip}`, {
      limit: env.AUTH_RATE_LIMIT,
      windowSeconds: env.AUTH_RATE_WINDOW_SECONDS,
    });
    if (!result.allowed) {
      reply.header('retry-after', String(result.retryAfterSeconds));
      await reply.code(429).send({ error: 'rate_limited' });
      return false;
    }
    return true;
  } catch (err) {
    // Availability over strictness on the auth path: never 5xx (or block) a login because Redis blipped.
    request.log.warn({ err, group }, 'rate limiter unavailable — failing open');
    return true;
  }
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/register', async (request, reply) => {
    if (!(await authRateLimitOk(app, request, reply, 'register'))) return reply;
    const { pg: pool } = app.deps;
    const parsed = RegisterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    }
    const { email, password, name } = parsed.data;

    // Pre-check is the fast path; the users.email UNIQUE constraint is the real guard. The check-then-
    // insert races (TOCTOU): a concurrent registration can slip between the SELECT and the INSERT, so
    // the INSERT may still hit the UNIQUE index — translate that pg 23505 into the same clean 409 the
    // pre-check returns (never a 500 that would leak the pg error message).
    if (await findUserByEmail(pool, email)) return reply.code(409).send({ error: 'email_taken' });

    let user;
    try {
      user = await createUser(pool, {
        email,
        passwordHash: hashPassword(password),
        ...(name !== undefined ? { name } : {}),
      });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: 'email_taken' });
      throw err;
    }
    const { token } = await createSession(pool, user.id);
    setSessionCookie(app, reply, token);
    // Issue + dispatch an email-verification link (the dev transport logs it). buildApp always defaults
    // app.deps.email, so the non-null assertion is safe. Login is NOT blocked while unverified — the
    // email_verified flag is surfaced (here + /v1/me) so the UI can nudge.
    const verifyToken = await issueEmailVerificationToken(pool, user.id);
    await app.deps.email!.send({
      to: user.email,
      subject: 'Verify your agentOps email',
      kind: 'verify_email',
      link: `${app.deps.env.APP_BASE_URL}/verify-email?token=${verifyToken}`,
    });
    return reply.code(201).send({
      user: { id: user.id, email: user.email, name: user.name, email_verified: user.emailVerified },
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    if (!(await authRateLimitOk(app, request, reply, 'login'))) return reply;
    const { pg: pool } = app.deps;
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { email, password } = parsed.data;

    const user = await findUserByEmail(pool, email);
    // Constant-shape AND constant-cost failure: unknown email and wrong password are indistinguishable
    // to the client — same 401 body AND the same scrypt work. On the no-user / no-hash branch we run a
    // dummy verify against a fixed precomputed digest so an attacker cannot enumerate accounts by timing
    // (an unknown email must not return measurably faster than a known-email-wrong-password attempt).
    if (!user || !user.passwordHash) {
      verifyPassword(password, DUMMY_PASSWORD_DIGEST);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const { token } = await createSession(pool, user.id);
    setSessionCookie(app, reply, token);
    return reply.code(200).send({
      user: { id: user.id, email: user.email, name: user.name, email_verified: user.emailVerified },
    });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const token = parseCookies(request.headers.cookie)[env.SESSION_COOKIE_NAME];
    if (token) await revokeSession(pool, token);
    clearSessionCookie(app, reply);
    return reply.code(204).send();
  });
}
