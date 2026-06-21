import { describe, it, expect, afterEach } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';

/**
 * App-level error handler: a thrown/propagated error (e.g. a raw pg failure) must NEVER serialize its
 * message into the 500 body. We assert the generic shape and that the leaky DB message is absent.
 *
 * Docker-free: a fake pool whose `query` throws a recognizable pg-style error drives the unhandled
 * path through the real route + the real setErrorHandler — no Testcontainers needed.
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

const LEAKY_PG_MESSAGE =
  'relation "users" does not exist at character 42 — SELECT ... FROM users WHERE email = $1';

/** Build an app whose pg pool throws a leaky message on every query. */
function buildFailingApp(): FastifyInstance {
  const env = loadEnv(TEST_ENV);
  const throwingPool = {
    query: () => Promise.reject(new Error(LEAKY_PG_MESSAGE)),
  } as unknown as pg.Pool;
  const noopRedis = {} as unknown as Redis;
  return buildApp({ env, pg: throwingPool, redis: noopRedis });
}

describe('app setErrorHandler (5xx genericize, no DB-message leak)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns a generic 500 body and does NOT leak the pg error message', async () => {
    app = buildFailingApp();
    // Valid body so zod passes; the failure comes from the (throwing) DB query, propagating unhandled.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'someone@test.com', password: 'a-strong-password' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toBe('internal_error');
    // The leaky DB internals must be absent from the serialized body.
    expect(res.body).not.toContain('relation "users"');
    expect(res.body).not.toContain('does not exist');
    expect(res.body).not.toContain(LEAKY_PG_MESSAGE);
  });

  it('preserves a sub-500 status from a validation error (does not genericize 400s)', async () => {
    app = buildFailingApp();
    // Malformed body → route returns its own explicit 400 (never reaches the throwing query).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });
});
