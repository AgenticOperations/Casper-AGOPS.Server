import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from '../config/env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Forward-only SQL migration runner.
 *
 * Each `NNNN_name.sql` file in ./migrations runs exactly once, in lexical order,
 * inside its own transaction. Applied ids are recorded in `schema_migrations`, so
 * re-running is a no-op. There is no down-migration path: the ledger is append-only
 * and so is its schema history.
 */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id          text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const appliedRes = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.id));

  const ran: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (applied.has(id)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      ran.push(id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${id} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}

// CLI entrypoint: `npm run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  runMigrations(pool)
    .then((ran) => {
      // eslint-disable-next-line no-console
      console.log(ran.length ? `applied: ${ran.join(', ')}` : 'no pending migrations');
      return pool.end();
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('migration run failed', err);
      process.exit(1);
    });
}
