import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { privateKeyToAccount } from 'viem/accounts';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { GatewayClient } from '../../src/lib/circle/gateway.js';
import { LocalKmsSigner } from '../../src/lib/kms/signer.js';
import type { TokenDomainSource } from '../../src/lib/eip712/domain.js';
import type { DomainRegistry } from '../../src/engines/identity/domain-binding.js';
import {
  assignPolicy,
  createOrg,
  createPolicyVersion,
  registerAgent,
} from '../../src/engines/control/store.js';
import { recompileAgentPolicy } from '../../src/engines/control/publish.js';
import { bumpOrgEpoch } from '../../src/engines/control/epoch.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { AllocationPolicy, SpendPolicy } from '../../src/contracts/index.js';

/**
 * Shared L6 Oracle harness: Testcontainers pg+redis, a full hot-path app (LocalKmsSigner + stubbed
 * EIP-5267 domain source), and a one-call agent seeder. Kept in one place so each claim file asserts
 * a single behaviour without re-deriving the 40-line container + policy boilerplate.
 */

export const CHAIN_ID = 421_614;
export const RESOURCE = 'svc:weather';
export const VENDOR = '0x4444444444444444444444444444444444444444';
export const TOKEN = '0x5555555555555555555555555555555555555555';

// Well-known public anvil test keys — NOT secrets; throwaway, local signing only.
export const agentFloat = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const treasury = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);
export const signer = new LocalKmsSigner({ 'agent-float': agentFloat, 'treasury-allocation': treasury });

// EIP-5267 seam stub: simulates the on-chain eip712Domain() read for the token (USDC version "2").
export const tokenDomainSource: TokenDomainSource = {
  readEip712Domain: ({ address }) =>
    Promise.resolve({ name: 'USD Coin', version: '2', chainId: BigInt(CHAIN_ID), verifyingContract: address }),
};

// E7 domain-binding stub (BUG-17): the test vendor host publishes VENDOR; everything else is unverified.
// requestContext.url host = 'api.weather.example', and raw402 pays VENDOR, so the hot-path ALLOW tests bind.
export const domainRegistry: DomainRegistry = {
  resolvePaymentAddress: (host) => Promise.resolve(host === 'api.weather.example' ? VENDOR : null),
};

/** Permissive binding stub: binds any host to `addr` — for tests not exercising the binding gate itself. */
export const bindAnyTo = (addr: string): DomainRegistry => ({
  resolvePaymentAddress: () => Promise.resolve(addr),
});

const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: String(CHAIN_ID),
  ARC_USDC_ADDRESS: TOKEN,
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

export const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

export interface Stores {
  pgc: StartedPostgreSqlContainer;
  redisc: StartedTestContainer;
  pool: pg.Pool;
  redis: Redis;
}

/** Start pg+redis and run migrations. Returns null when no container runtime is available. */
export async function startStores(): Promise<Stores | null> {
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

export async function stopStores(s: Stores | null): Promise<void> {
  if (!s) return;
  await s.pool.end();
  await s.redis.quit();
  await s.redisc.stop();
  await s.pgc.stop();
}

/** Build the full HTTP surface with the hot-path wired (signer + domain source).
 *
 * @param envOverride - Optional env key overrides merged into TEST_ENV before loadEnv.
 *   Used by demo routes tests to set DEMO_ENABLED='true' without spinning a second process.
 *   Example: `buildOracleApp(pool, redis, undefined, undefined, { DEMO_ENABLED: 'true' })`
 */
export function buildOracleApp(
  pool: pg.Pool,
  redis: Redis,
  logStream?: { write(msg: string): void },
  gateway?: GatewayClient,
  envOverride?: Record<string, string>,
): FastifyInstance {
  const env = loadEnv({ ...TEST_ENV, ...(envOverride ?? {}) });
  return buildApp({
    env,
    pg: pool,
    redis,
    hotPath: { signer, tokenDomainSource, domainRegistry, chainId: CHAIN_ID },
    ...(logStream ? { logStream } : {}),
    ...(gateway ? { gateway } : {}),
  });
}

/**
 * Seed a minimal org with an admin key only (no agents, no policies). Returns `{orgId, sk}`.
 * Used by control-plane tests (e.g. treasury guard) that need a valid `sk_` bearer without
 * the full hot-path policy scaffolding that `seedAgent` wires up.
 */
export async function seedOrgAdmin(pool: pg.Pool, name = 'Acme'): Promise<{ orgId: string; sk: string }> {
  const key = issueAdminKey();
  const org = await createOrg(pool, { name, adminKeyHash: key.hash });
  return { orgId: org.id, sk: key.token };
}

/** Seed a fresh org+agent with an org-scoped spend (cap=$cap) + allocation policy, cache made fresh. */
export async function seedAgent(
  pool: pg.Pool,
  redis: Redis,
  cap = 10,
): Promise<{
  orgId: string;
  agentId: string;
  apiKey: string;
  adminKey: string;
  allocation: AllocationPolicy;
}> {
  const admin = issueAdminKey();
  const org = await createOrg(pool, { name: 'Acme', adminKeyHash: admin.hash });
  const { agent, apiKey } = await registerAgent(pool, { orgId: org.id });
  const spend: SpendPolicy = {
    spendCap: usdc(cap),
    perTransactionMax: usdc(1000),
    serviceScope: [RESOURCE, 'svc:casper-paid-api', 'cspr.trade:swap', 'casper:deploy:guard-registry'],
    railPermission: ['raw-x402', 'casper-x402', 'cspr-trade', 'casper-deploy'],
    velocityLimitPerHour: 100,
  };
  const allocation: AllocationPolicy = {
    totalBudget: usdc(1000),
    perAgentMax: usdc(1000),
    cooldownSeconds: 0,
    // The AllocationPolicy fence is the depositFor OWN-AGENTS allowlist (policy-engine-FINAL.md:128),
    // never a vendor allowlist — it lists the org's own agent float addresses. The spend-path recipient
    // is bound separately by the E7 Domain Binding Verifier (enforce.ts step 4b). The test float is the
    // shared agent-float account, so a depositFor to it passes the fence; an external addr is denied.
    allowedDestinations: [agentFloat.address],
  };
  const sp = await createPolicyVersion(pool, { orgId: org.id, class: 'spend', rules: spend });
  const ap = await createPolicyVersion(pool, { orgId: org.id, class: 'allocation', rules: allocation });
  await assignPolicy(pool, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: sp.policyId, class: 'spend' });
  await assignPolicy(pool, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: ap.policyId, class: 'allocation' });
  const eff = await recompileAgentPolicy(pool, redis, agent.id);
  await bumpOrgEpoch(redis, org.id, eff.policyEpoch);
  return { orgId: org.id, agentId: agent.id, apiKey: apiKey.token, adminKey: admin.token, allocation };
}

/** A raw-x402 402 body advertising `amountUsdc` USDC to the test vendor for the test resource. */
export function raw402(amountUsdc: number): {
  x402Version: number;
  accepts: Array<Record<string, unknown>>;
} {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'arc-testnet',
        maxAmountRequired: usdc(amountUsdc).toString(),
        resource: RESOURCE,
        payTo: VENDOR,
        maxTimeoutSeconds: 600,
        asset: TOKEN,
      },
    ],
  };
}

export const requestContext = { method: 'GET', url: 'https://api.weather.example/v1/current' };
