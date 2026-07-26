import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EncryptedStoreVault } from '../../src/engines/custody/key-vault.js';
import { createPgVaultBlobStore } from '../../src/engines/custody/pg-vault-blob-store.js';
import { readActiveDelegatedKeyRow } from '../../src/engines/identity/delegation/delegated-keys-store.js';
import { seedUserOrgOwner } from '../helpers/identity-harness.js';

/**
 * Task 3 (Half-1 wiring): POST /v1/agents auto-grants a vault-backed delegated key WHEN a vault is
 * present on AppDeps, and stays custodial (no delegated key, no error) when it is absent.
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

// 32 bytes of hex — a throwaway master secret for the test vault.
const MASTER_SECRET_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let pgc: StartedPostgreSqlContainer | undefined;
let redisc: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

beforeAll(async () => {
  try {
    pgc = await new PostgreSqlContainer('postgres:16-alpine').start();
    redisc = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    pool = new pg.Pool({ connectionString: pgc.getConnectionUri() });
    redis = new Redis({ host: redisc.getHost(), port: redisc.getMappedPort(6379), maxRetriesPerRequest: 3 });
    await runMigrations(pool);
  } catch {
    dockerAvailable = false;
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await redis?.quit();
  await redisc?.stop();
  await pgc?.stop();
});

function buildAppWithVault(p: pg.Pool, r: Redis, withVault: boolean): FastifyInstance {
  const env = loadEnv({ ...TEST_ENV });
  const vault = withVault
    ? new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET_HEX, store: createPgVaultBlobStore(p) })
    : undefined;
  return buildApp({ env, pg: p, redis: r, ...(vault ? { vault } : {}) });
}

describe('POST /v1/agents auto-grants a vault-backed delegated key (Half-1)', () => {
  it('with a vault present → 201, response has delegated_public_key, and a pending delegated key row exists', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, true);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-key-owner@test.com');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie },
        payload: { name: 'vault-agent' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{
        agent: { id: string };
        api_key: string;
        delegated_public_key?: string;
      }>();
      expect(typeof body.delegated_public_key).toBe('string');
      expect((body.delegated_public_key ?? '').length).toBeGreaterThan(0);

      const row = await readActiveDelegatedKeyRow(pool, body.agent.id);
      expect(row).not.toBeNull();
      expect(row?.grantState).toBe('pending');
      expect(row?.publicKey).toBe(body.delegated_public_key);
    } finally {
      await app.close();
    }
  });

  it('with NO vault → 201, response omits delegated_public_key, and no delegated key row exists (custodial fallback)', async ({
    skip,
  }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, false);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'no-vault-owner@test.com');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie },
        payload: { name: 'custodial-agent' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ agent: { id: string }; delegated_public_key?: string }>();
      expect(body.delegated_public_key).toBeUndefined();

      const row = await readActiveDelegatedKeyRow(pool, body.agent.id);
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });
});
