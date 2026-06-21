import { describe, it, expect, afterEach, vi } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../../src/config/env.js';

/**
 * Docker-free unit tests for two security fixes in the auth routes, driven through the REAL Fastify
 * route + error handler against a fake pg pool (no Testcontainers):
 *
 *   Fix 2 — register TOCTOU: a pg 23505 unique_violation from the INSERT must surface as a clean 409
 *           {error:'email_taken'}, never a 500 leaking the pg message.
 *   Fix 3 — login timing: the unknown-email branch must still pay a scrypt verify (dummy digest), so an
 *           attacker cannot enumerate accounts by response timing.
 */
const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '421614',
  ARC_USDC_ADDRESS: '0x5555555555555555555555555555555555555555',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

// A spy we can assert was called on the unknown-email login path. Hoisted so the vi.mock factory
// (which is hoisted above imports) can close over it.
const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }));

vi.mock('../../src/lib/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/password.js')>();
  return {
    ...actual,
    verifyPassword: (plaintext: string, digest: string) => {
      verifySpy(plaintext, digest);
      return actual.verifyPassword(plaintext, digest);
    },
  };
});

// Imported AFTER the mock so buildApp's transitive import of password.js is the mocked one.
const { buildApp } = await import('../../src/app.js');

const noopRedis = {} as unknown as Redis;

function buildAppWithPool(pool: pg.Pool): FastifyInstance {
  const env = loadEnv(TEST_ENV);
  return buildApp({ env, pg: pool, redis: noopRedis });
}

describe('auth routes — security fix unit tests (Docker-free)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    verifySpy.mockClear();
  });

  it('Fix 2: register translates a pg 23505 unique_violation into 409, no pg-message leak', async () => {
    const leakyUniqueMsg =
      'duplicate key value violates unique constraint "users_email_key" — Key (email)=(x@test.com)';
    // Pre-check SELECT returns no row (TOCTOU window); the INSERT then loses the race → 23505.
    const pool = {
      query: (text: string) => {
        if (/^\s*INSERT INTO users/i.test(text)) {
          const err = Object.assign(new Error(leakyUniqueMsg), { code: '23505' });
          return Promise.reject(err);
        }
        return Promise.resolve({ rows: [] }); // pre-check finds nothing
      },
    } as unknown as pg.Pool;
    app = buildAppWithPool(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'race@test.com', password: 'a-strong-password', name: 'Race' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('email_taken');
    // The pg constraint detail must never reach the client.
    expect(res.body).not.toContain('unique constraint');
    expect(res.body).not.toContain('users_email_key');
    expect(res.body).not.toContain(leakyUniqueMsg);
  });

  it('Fix 2: a non-23505 INSERT error still genericizes to a 500 (no leak)', async () => {
    const pool = {
      query: (text: string) => {
        if (/^\s*INSERT INTO users/i.test(text)) {
          return Promise.reject(
            Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }),
          );
        }
        return Promise.resolve({ rows: [] });
      },
    } as unknown as pg.Pool;
    app = buildAppWithPool(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'boom@test.com', password: 'a-strong-password' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toBe('internal_error');
    expect(res.body).not.toContain('connection terminated');
  });

  it('Fix 3: unknown-email login returns 401 AND exercises the dummy scrypt-verify path', async () => {
    // findUserByEmail returns no row → the unknown-email branch.
    const pool = {
      query: () => Promise.resolve({ rows: [] }),
    } as unknown as pg.Pool;
    app = buildAppWithPool(pool);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ghost@test.com', password: 'whatever-strong' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('invalid_credentials');
    // The timing-equalization guard: the verify code path MUST run even with no user, against the
    // fixed dummy digest (so unknown-email is not measurably faster than wrong-password).
    expect(verifySpy).toHaveBeenCalledTimes(1);
    const [, digestArg] = verifySpy.mock.calls[0] as [string, string];
    expect(digestArg.startsWith('scrypt$')).toBe(true);
  });
});
