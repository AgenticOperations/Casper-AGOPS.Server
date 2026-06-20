import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

function stubPg(ok: boolean): pg.Pool {
  return {
    query: () => Promise.resolve({ rows: [{ ok: ok ? 1 : 0 }] }),
  } as unknown as pg.Pool;
}

function stubRedis(ok: boolean): Redis {
  return {
    status: 'ready',
    ping: () => Promise.resolve(ok ? 'PONG' : 'NOPE'),
  } as unknown as Redis;
}

describe('liveness and readiness', () => {
  it('GET /healthz is 200 regardless of store state (liveness)', async () => {
    const env = loadEnv(TEST_ENV);
    const app = buildApp({ env, pg: stubPg(false), redis: stubRedis(false) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /readyz is 200 when both stores ping', async () => {
    const env = loadEnv(TEST_ENV);
    const app = buildApp({ env, pg: stubPg(true), redis: stubRedis(true) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { postgres: true, redis: true } });
    await app.close();
  });

  it('GET /readyz is 503 when a store is unreachable', async () => {
    const env = loadEnv(TEST_ENV);
    const app = buildApp({ env, pg: stubPg(true), redis: stubRedis(false) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not-ready', checks: { redis: false } });
    await app.close();
  });
});
