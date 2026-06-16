import type pg from 'pg';
import { newTokenRowId, issueOpaqueToken, hashApiKey } from '../../../lib/ids.js';

/** Email-verify + password-reset tokens. Same posture as sessions: store only the sha256 hash. */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const RESET_TTL_MS = 60 * 60 * 1000; // 1h

type TokenTable = 'email_verification_tokens' | 'password_reset_tokens';

async function issueToken(
  pool: pg.Pool,
  table: TokenTable,
  userId: string,
  ttlMs: number,
): Promise<string> {
  const id = newTokenRowId();
  const { token, hash } = issueOpaqueToken();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await pool.query(
    `INSERT INTO ${table} (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [id, userId, hash, expiresAt],
  );
  return token;
}

/** Consume a token: returns the userId iff live+unused, and marks it used in the SAME statement (atomic). */
async function consumeToken(
  pool: pg.Pool,
  table: TokenTable,
  token: string,
): Promise<{ userId: string } | null> {
  const res = await pool.query<{ user_id: string }>(
    `UPDATE ${table} SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
    [hashApiKey(token)],
  );
  return res.rows[0] ? { userId: res.rows[0].user_id } : null;
}

export const issueEmailVerificationToken = (pool: pg.Pool, userId: string): Promise<string> =>
  issueToken(pool, 'email_verification_tokens', userId, VERIFY_TTL_MS);
export const consumeEmailVerificationToken = (
  pool: pg.Pool,
  token: string,
): Promise<{ userId: string } | null> =>
  consumeToken(pool, 'email_verification_tokens', token);
export const issuePasswordResetToken = (pool: pg.Pool, userId: string): Promise<string> =>
  issueToken(pool, 'password_reset_tokens', userId, RESET_TTL_MS);
export const consumePasswordResetToken = (
  pool: pg.Pool,
  token: string,
): Promise<{ userId: string } | null> => consumeToken(pool, 'password_reset_tokens', token);
