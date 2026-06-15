import pg from 'pg';
import type { Env } from '../config/env.js';

const { Pool } = pg;

/**
 * Postgres connection pool (the cold tier: control plane, ledger-cold, identity).
 *
 * One pool per process. Construction is lazy and explicit so tests can spin up a
 * Testcontainers Postgres and hand its URL in, rather than reaching for a global.
 */
export function createPgPool(env: Pick<Env, 'DATABASE_URL'>): pg.Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // Hot-path-adjacent reads must not hang the event loop on a dead backend.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });
  return pool;
}

/** Liveness probe used by /healthz. Returns true iff a trivial query round-trips. */
export async function pingPg(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}
