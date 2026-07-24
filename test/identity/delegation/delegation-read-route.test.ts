import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { EncryptedStoreVault } from '../../../src/engines/custody/key-vault.js';
import { createPgVaultBlobStore } from '../../../src/engines/custody/pg-vault-blob-store.js';
import { revokeDelegatedKey } from '../../../src/engines/identity/delegation/delegated-keys-store.js';
import { seedUserOrgOwner } from '../../helpers/identity-harness.js';

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

function buildAppWithVault(p: pg.Pool, r: Redis): FastifyInstance {
  const env = loadEnv({ ...TEST_ENV });
  const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET_HEX, store: createPgVaultBlobStore(p) });
  return buildApp({ env, pg: p, redis: r, vault });
}

async function createAgentWithKey(app: FastifyInstance, cookie: string): Promise<{ agentId: string; delegatedPublicKey: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: { name: 'delegation-read-agent' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ agent: { id: string }; delegated_public_key: string }>();
  return { agentId: body.agent.id, delegatedPublicKey: body.delegated_public_key };
}

describe('GET /v1/agents/:id/delegation', () => {
  it('200 has_key:true + public_key + grant_state pending for an agent with an active delegated key', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'delegation-read-owner@test.com');
      const { agentId, delegatedPublicKey } = await createAgentWithKey(app, cookie);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/delegation`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        has_key: true,
        public_key: delegatedPublicKey,
        grant_state: 'pending',
      });
    } finally {
      await app.close();
    }
  });

  it('200 has_key:false with nulls for an agent with no active delegated key', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'delegation-read-nokey@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);
      await revokeDelegatedKey(pool, { agentId });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/delegation`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ has_key: false, public_key: null, grant_state: null });
    } finally {
      await app.close();
    }
  });

  it('404 agent_not_found for an agent owned by a different org', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const owner = await seedUserOrgOwner(pool, 'delegation-read-org-a@test.com');
      const { agentId } = await createAgentWithKey(app, owner.cookie);
      const other = await seedUserOrgOwner(pool, 'delegation-read-org-b@test.com');

      const res = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/delegation`,
        headers: { cookie: other.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'agent_not_found' });
    } finally {
      await app.close();
    }
  });

  it('401 with no credentials', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'delegation-read-noauth@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/delegation`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
