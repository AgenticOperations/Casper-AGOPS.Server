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
import {
  readActiveDelegatedKeyRow,
  markDelegatedKeyGranted,
  revokeDelegatedKey,
} from '../../../src/engines/identity/delegation/delegated-keys-store.js';
import {
  createStubAssociatedKeyVerifier,
  type AssociatedKeyVerifyResult,
} from '../../../src/engines/identity/delegation/verify-associated-key.js';
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
const DEPLOY_HASH = 'a'.repeat(64);

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

function buildAppWithVault(p: pg.Pool, r: Redis, stub?: AssociatedKeyVerifyResult): FastifyInstance {
  const env = loadEnv({ ...TEST_ENV });
  const vault = new EncryptedStoreVault({ masterSecretHex: MASTER_SECRET_HEX, store: createPgVaultBlobStore(p) });
  const deps: Parameters<typeof buildApp>[0] = { env, pg: p, redis: r, vault };
  if (stub) deps.associatedKeyVerifier = createStubAssociatedKeyVerifier(stub);
  return buildApp(deps);
}

async function createAgentWithKey(app: FastifyInstance, cookie: string): Promise<{ agentId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: { name: 'grant-confirm-agent' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ agent: { id: string } }>();
  return { agentId: body.agent.id };
}

function confirm(app: FastifyInstance, cookie: string, agentId: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/grant-delegated-key/confirm`,
    headers: { cookie },
    payload: payload as object,
  });
}

describe('POST /v1/agents/:id/grant-delegated-key/confirm', () => {
  it('200: verifier ok+weight1 promotes the key to granted', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, { ok: true, weight: 1 });
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-confirm-ok@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);

      const res = await confirm(app, cookie, agentId, { deploy_hash: DEPLOY_HASH, master_public_key: MASTER_PUBLIC_KEY });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ agent_id: agentId, grant_state: 'granted' });

      const row = await readActiveDelegatedKeyRow(pool, agentId);
      expect(row?.grantState).toBe('granted');
      expect(row?.grantDeployHash).toBe(DEPLOY_HASH);
    } finally {
      await app.close();
    }
  });

  it('202: not_finalized_yet leaves the row pending', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, { ok: false, reason: 'not_finalized_yet' });
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-confirm-pending@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);

      const res = await confirm(app, cookie, agentId, { deploy_hash: DEPLOY_HASH });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ grant_state: 'pending', reason: 'not_finalized_yet' });

      const row = await readActiveDelegatedKeyRow(pool, agentId);
      expect(row?.grantState).toBe('pending');
    } finally {
      await app.close();
    }
  });

  it('422: key_not_associated leaves the row pending', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, { ok: false, reason: 'key_not_associated' });
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-confirm-notassoc@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);

      const res = await confirm(app, cookie, agentId, { deploy_hash: DEPLOY_HASH });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'grant_not_confirmed' });

      const row = await readActiveDelegatedKeyRow(pool, agentId);
      expect(row?.grantState).toBe('pending');
    } finally {
      await app.close();
    }
  });

  it('400: invalid (short) deploy_hash', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, { ok: true, weight: 1 });
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-confirm-badhash@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);

      const res = await confirm(app, cookie, agentId, { deploy_hash: 'abcd' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_body' });
    } finally {
      await app.close();
    }
  });

  it('404: cross-org agent', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, { ok: true, weight: 1 });
    try {
      const owner = await seedUserOrgOwner(pool, 'grant-confirm-org-a@test.com');
      const { agentId } = await createAgentWithKey(app, owner.cookie);
      const other = await seedUserOrgOwner(pool, 'grant-confirm-org-b@test.com');

      const res = await confirm(app, other.cookie, agentId, { deploy_hash: DEPLOY_HASH });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'agent_not_found' });
    } finally {
      await app.close();
    }
  });

  it('200 idempotent: already-granted agent returns granted without re-verify', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    // Stub returns failure — if the route re-verified, this would NOT be 200.
    const app = buildAppWithVault(pool, redis, { ok: false, reason: 'key_not_associated' });
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-confirm-idem@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);
      await markDelegatedKeyGranted(pool, { agentId, deployHash: DEPLOY_HASH });

      const res = await confirm(app, cookie, agentId, { deploy_hash: DEPLOY_HASH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ agent_id: agentId, grant_state: 'granted' });
    } finally {
      await app.close();
    }
  });

  it('409: agent with no delegated key', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis) return skip();
    const app = buildAppWithVault(pool, redis, { ok: true, weight: 1 });
    try {
      const { cookie } = await seedUserOrgOwner(pool, 'grant-confirm-nokey@test.com');
      const { agentId } = await createAgentWithKey(app, cookie);
      await revokeDelegatedKey(pool, { agentId });
      expect(await readActiveDelegatedKeyRow(pool, agentId)).toBeNull();

      const res = await confirm(app, cookie, agentId, { deploy_hash: DEPLOY_HASH });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'no_delegated_key' });
    } finally {
      await app.close();
    }
  });
});
