import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUser } from '../../src/engines/identity/account/user-store.js';
import { createSession } from '../../src/engines/identity/account/session-store.js';
import { createOrg } from '../../src/engines/control/store.js';
import { addMembership } from '../../src/engines/identity/access/membership-store.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { DevLogEmailTransport } from '../../src/lib/email/transport.js';

/**
 * Identity-layer harness: Testcontainers pg+redis + a full app, WITHOUT the hot-path (these routes
 * never sign). Mirrors oracle-harness but omits signer/domain wiring — auth/membership routes fail
 * closed on their own and need no KMS. Skips (returns null) when no container runtime is available.
 */
const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '421614',
  ARC_USDC_ADDRESS: '0x5555555555555555555555555555555555555555',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

export interface IdStores {
  pgc: StartedPostgreSqlContainer;
  redisc: StartedTestContainer;
  pool: pg.Pool;
  redis: Redis;
}

export async function startIdStores(): Promise<IdStores | null> {
  try {
    const pgc = await new PostgreSqlContainer('postgres:16-alpine').start();
    const redisc = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const pool = new pg.Pool({ connectionString: pgc.getConnectionUri() });
    const redis = new Redis({
      host: redisc.getHost(),
      port: redisc.getMappedPort(6379),
      maxRetriesPerRequest: 3,
    });
    await runMigrations(pool);
    return { pgc, redisc, pool, redis };
  } catch {
    return null;
  }
}

export async function stopIdStores(s: IdStores | null): Promise<void> {
  if (!s) return;
  await s.pool.end();
  await s.redis.quit();
  await s.redisc.stop();
  await s.pgc.stop();
}

export function buildIdApp(
  pool: pg.Pool,
  redis: Redis,
  envOverride?: Record<string, string>,
): { app: FastifyInstance; email: DevLogEmailTransport } {
  const env = loadEnv({ ...TEST_ENV, ...(envOverride ?? {}) });
  // Inject a CAPTURING dev transport so tests can read the verify/reset link without a provider.
  const email = new DevLogEmailTransport();
  const app = buildApp({ env, pg: pool, redis, email });
  return { app, email };
}

/** Pull the session cookie value out of a Set-Cookie header for follow-up authed requests. */
export function sessionCookieFrom(
  setCookie: string | string[] | undefined,
  name = 'agentops_session',
): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const h of headers) {
    const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(h);
    if (m) return `${name}=${m[1]}`;
  }
  return null;
}

/** Seed a verified user that OWNS a fresh org, plus a usable session cookie. */
export async function seedUserOrgOwner(
  pool: pg.Pool,
  email: string,
  cookieName = 'agentops_session',
): Promise<{ userId: string; orgId: string; cookie: string }> {
  const user = await createUser(pool, {
    email,
    passwordHash: 'scrypt$x',
    emailVerified: true,
    name: 'Owner',
  });
  const org = await createOrg(pool, { name: 'OwnedCo', adminKeyHash: issueAdminKey().hash });
  await addMembership(pool, { userId: user.id, orgId: org.id, role: 'owner' });
  const { token } = await createSession(pool, user.id);
  return { userId: user.id, orgId: org.id, cookie: `${cookieName}=${token}` };
}

/**
 * Attach a verified user + membership (role-configurable) to an EXISTING org, returning a session
 * cookie. Lets a test reuse the fully policy-scaffolded org from the oracle harness's `seedAgent`
 * (so the seeded agent can authorize on the hot path) while driving the admin+ lifecycle routes.
 */
export async function seedMemberOnOrg(
  pool: pg.Pool,
  orgId: string,
  email: string,
  role: 'owner' | 'admin' | 'member' = 'owner',
  cookieName = 'agentops_session',
): Promise<{ userId: string; cookie: string }> {
  const user = await createUser(pool, {
    email,
    passwordHash: 'scrypt$x',
    emailVerified: true,
    name: 'Member',
  });
  await addMembership(pool, { userId: user.id, orgId, role });
  const { token } = await createSession(pool, user.id);
  return { userId: user.id, cookie: `${cookieName}=${token}` };
}
