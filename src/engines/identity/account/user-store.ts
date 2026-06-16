import type pg from 'pg';
import { newUserId } from '../../../lib/ids.js';

/** Users system of record. Email is citext-UNIQUE; lookups are case-insensitive at the DB layer. */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerified: boolean;
  name: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  email_verified: boolean;
  name: string;
}

function toUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    emailVerified: r.email_verified,
    name: r.name,
  };
}

export async function createUser(
  pool: pg.Pool,
  params: { email: string; passwordHash: string | null; name?: string; emailVerified?: boolean },
): Promise<UserRecord> {
  const id = newUserId();
  const res = await pool.query<UserRow>(
    `INSERT INTO users (id, email, password_hash, email_verified, name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, password_hash, email_verified, name`,
    [id, params.email, params.passwordHash, params.emailVerified ?? false, params.name ?? ''],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createUser: INSERT ... RETURNING produced no row');
  return toUser(row);
}

export async function findUserByEmail(pool: pg.Pool, email: string): Promise<UserRecord | null> {
  const res = await pool.query<UserRow>(
    'SELECT id, email, password_hash, email_verified, name FROM users WHERE email = $1',
    [email],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export async function findUserById(pool: pg.Pool, id: string): Promise<UserRecord | null> {
  const res = await pool.query<UserRow>(
    'SELECT id, email, password_hash, email_verified, name FROM users WHERE id = $1',
    [id],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export async function setUserPassword(
  pool: pg.Pool,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

export async function markEmailVerified(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [userId]);
}
