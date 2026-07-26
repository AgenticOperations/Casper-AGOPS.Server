import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/app.js';
import { loadEnv } from '../../../src/config/env.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { EncryptedStoreVault } from '../../../src/engines/custody/key-vault.js';
import { createPgVaultBlobStore } from '../../../src/engines/custody/pg-vault-blob-store.js';
import { readActiveDelegatedKeyRow, revokeDelegatedKey } from '../../../src/engines/identity/delegation/delegated-keys-store.js';
import { accountHashFromPublicKeyHex } from '../../../src/engines/identity/delegation/associated-keys.js';
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
const MASTER_PUBLIC_KEY = '0202f5a92ab6da536e7b1a351406f3744d27d7f92e5ae0c38911a03ba9edde30c179';
const GRANT_SHA = 'd57786c8f9503190231d4c99261e56d61e631fa566fede9e8d974350551bce44';

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
    payload: { name: 'grant-init-agent' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ agent: { id: string }; delegated_public_key: string }>();
  return { agentId: body.agent.id, delegatedPublicKey: body.delegated_public_key };
}

describe('POST /v1/agents/:id/grant-delegated-key/init', () => {
  it('200: returns unsigned grant + wasm_base64 + chain_name; server signs nothing', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-init-owner@test.com');
      const { agentId, delegatedPublicKey } = await createAgentWithKey(app, cookie);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/grant-delegated-key/init`,
        headers: { cookie },
        payload: { master_public_key: MASTER_PUBLIC_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        unsigned_grant: {
          master_account_hash: string;
          agent_account_hash: string;
          args: { agent_account_hash: string; master_weight: number; key_management_threshold: number; deployment_threshold: number };
        };
        wasm_base64: string;
        chain_name: string;
      }>();

      expect(body.unsigned_grant.agent_account_hash).toBe(accountHashFromPublicKeyHex(delegatedPublicKey));
      expect(body.unsigned_grant.master_account_hash).toBe(accountHashFromPublicKeyHex(MASTER_PUBLIC_KEY));
      expect(body.unsigned_grant.args).toEqual({
        agent_account_hash: accountHashFromPublicKeyHex(delegatedPublicKey),
        master_weight: 3,
        key_management_threshold: 3,
        deployment_threshold: 1,
      });
      const wasm = Buffer.from(body.wasm_base64, 'base64');
      expect(createHash('sha256').update(wasm).digest('hex')).toBe(GRANT_SHA);
      expect(body.chain_name).toBe('casper-test');
    } finally {
      await app.close();
    }
  });

  it('409 no_delegated_key when the agent has no active delegated key', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-init-nokey@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);
      await revokeDelegatedKey(pool, { agentId });
      expect(await readActiveDelegatedKeyRow(pool, agentId)).toBeNull();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/grant-delegated-key/init`,
        headers: { cookie },
        payload: { master_public_key: MASTER_PUBLIC_KEY },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'no_delegated_key' });
    } finally {
      await app.close();
    }
  });

  it('404 agent_not_found for an agent owned by a different org', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const owner = await seedUserOrgOwner(pool, 'grant-init-org-a@test.com');
      const { agentId } = await createAgentWithKey(app, owner.cookie);
      const other = await seedUserOrgOwner(pool, 'grant-init-org-b@test.com');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/grant-delegated-key/init`,
        headers: { cookie: other.cookie },
        payload: { master_public_key: MASTER_PUBLIC_KEY },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'agent_not_found' });
    } finally {
      await app.close();
    }
  });

  it('400 invalid_body when master_public_key is missing or not hex', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis);
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-init-badbody@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);

      const missing = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/grant-delegated-key/init`,
        headers: { cookie },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toEqual({ error: 'invalid_body' });

      const notHex = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agentId}/grant-delegated-key/init`,
        headers: { cookie },
        payload: { master_public_key: 'not-a-hex-key' },
      });
      expect(notHex.statusCode).toBe(400);
      expect(notHex.json()).toEqual({ error: 'invalid_body' });
    } finally {
      await app.close();
    }
  });
});
