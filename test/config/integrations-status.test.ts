import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';

/**
 * Honest mode reporting (Docker-free): GET /v1/integrations/status reports the SELECTED transport/read
 * MODE derived from env — circle 'live' iff CIRCLE_API_KEY is non-empty, arc 'live' iff ARC_LIVE==='true'.
 * Public (no auth) because it reveals only a mode label. It must NEVER include the key or any secret.
 * Mirrors the credential gates wired in server.ts (HTTP transport) and hotpath.ts (viem live read).
 */
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

// The route reads nothing from the stores; trivial stubs keep it Docker-free.
const stubPg = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;
const stubRedis = { status: 'ready' } as unknown as Redis;

function statusFor(envOverride: Record<string, string>): ReturnType<typeof buildApp> {
  const env = loadEnv({ ...TEST_ENV, ...envOverride });
  return buildApp({ env, pg: stubPg, redis: stubRedis });
}

describe('GET /v1/integrations/status', () => {
  it('reports both local by default (no credentials, ARC_LIVE off)', async () => {
    const app = statusFor({});
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ circle: 'local', arc: 'local' });
    await app.close();
  });

  it('reports circle local when a key is present but Gateway is NOT explicitly enabled', async () => {
    // A key may be configured for other Circle use; treasury stays on the working transport until the
    // on-chain Gateway protocol is integrated and CIRCLE_GATEWAY_LIVE is flipped.
    const app = statusFor({ CIRCLE_API_KEY: 'sk_live_present' });
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/status' });
    expect(res.json()).toEqual({ circle: 'local', arc: 'local' });
    await app.close();
  });

  it("reports circle 'live' only when CIRCLE_GATEWAY_LIVE='true' AND a key is set, without echoing the key", async () => {
    const SECRET = 'sk_live_must_not_appear';
    const app = statusFor({ CIRCLE_API_KEY: SECRET, CIRCLE_GATEWAY_LIVE: 'true' });
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ circle: 'live', arc: 'local' });
    // The secret must never appear in the response body.
    expect(res.body).not.toContain(SECRET);
    await app.close();
  });

  it("reports arc 'live' when ARC_LIVE='true'", async () => {
    const app = statusFor({ ARC_LIVE: 'true' });
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ circle: 'local', arc: 'live' });
    await app.close();
  });

  it('is public — no auth required', async () => {
    const app = statusFor({});
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/status' });
    // No 401/403: it reports only a mode label, never a secret.
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
