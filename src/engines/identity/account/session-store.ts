import type pg from 'pg';
import { newSessionId, issueOpaqueToken, hashApiKey } from '../../../lib/ids.js';
import { parseCookies } from '../../../lib/cookies.js';

/** Server-side opaque sessions. Only the sha256 hash is stored; the plaintext lives in the cookie. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(
  pool: pg.Pool,
  userId: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: Date }> {
  const id = newSessionId();
  const { token, hash } = issueOpaqueToken();
  const expiresAt = new Date(now + SESSION_TTL_MS);
  await pool.query(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [id, userId, hash, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

/** Resolve a live session token to its user id. Expired / revoked / unknown all yield null. */
export async function resolveSession(
  pool: pg.Pool,
  token: string,
): Promise<{ userId: string } | null> {
  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashApiKey(token)],
  );
  return res.rows[0] ? { userId: res.rows[0].user_id } : null;
}

/**
 * Bootstrap seam: resolve a session cookie straight to its userId WITHOUT requiring an org membership.
 * `authenticatePrincipal` deliberately 403s a session that has zero memberships (no org to scope to);
 * but org-creation is exactly the path where a brand-new user has none yet. This helper authenticates
 * the cookie alone so the first-org flow can mint the user's first tenant. Fail-closed: a missing,
 * expired, or revoked cookie yields null (the caller answers 401).
 */
export async function resolveSessionUserId(
  pool: pg.Pool,
  cookieHeader: string | undefined,
  cookieName: string,
): Promise<string | null> {
  const token = parseCookies(cookieHeader)[cookieName];
  if (!token) return null;
  const sess = await resolveSession(pool, token);
  return sess?.userId ?? null;
}

/** Idempotent revoke (logout). A missing/already-revoked token is a no-op. */
export async function revokeSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashApiKey(token)],
  );
}

/**
 * Revoke EVERY live session for a user (invalidate-on-reset). On a password reset we cannot assume the
 * attacker only holds the credential — a previously stolen session cookie must also die. Returns the
 * number of sessions revoked. Idempotent: already-revoked rows are skipped.
 */
export async function revokeAllUserSessions(pool: pg.Pool, userId: string): Promise<number> {
  const res = await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return res.rowCount ?? 0;
}
