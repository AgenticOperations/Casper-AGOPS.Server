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
  // An idle backend connection can be dropped by Postgres (restart, network reset,
  // idle_in_transaction timeout). pg re-emits that as an 'error' event on the pool;
  // with no listener attached, Node treats it as an unhandled 'error' and crashes the
  // whole process (`throw er;`). Attach a handler so the dead client is logged and
  // discarded — the pool transparently opens a fresh connection on the next query.
  pool.on('error', (err) => {
    console.error('[pg-pool] idle client error — connection dropped, will reconnect:', err.message);
  });
  return pool;
}

/** Liveness probe used by /healthz. Returns true iff a trivial query round-trips. */
export async function pingPg(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}
