import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type Address } from 'viem';
import { runMigrations } from '../../src/db/migrate.js';
import { assignPolicy, createOrg, createPolicyVersion, registerAgent } from '../../src/engines/control/store.js';
import { recompileAgentPolicy } from '../../src/engines/control/publish.js';
import { bumpOrgEpoch } from '../../src/engines/control/epoch.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { keys } from '../../src/redis/keyspace.js';
import { LocalKmsSigner } from '../../src/lib/kms/signer.js';
import { EIP3009_TYPES } from '../../src/lib/eip712/eip3009.js';
import type { TokenDomainSource } from '../../src/lib/eip712/domain.js';
import type { DomainRegistry } from '../../src/engines/identity/domain-binding.js';
import { decodeXPayment } from '../../src/engines/enforcement/x-payment.js';
import { enforceSpend, type EnforceDeps } from '../../src/engines/enforcement/enforce.js';
import type { AllocationPolicy, Quote, SpendPolicy } from '../../src/contracts/index.js';

/**
 * E3 orchestrator `enforceSpend` — the agent-egress hot-path spine (policy-engine-FINAL.md §4 steps
 * 2-8, engine-specs-FINAL.md:119-140). deny_all kill-switch → capture effective policy → hold-inclusive
 * window + velocity read → deny-by-default SpendPolicy → on ALLOW: atomic grant claim (dedup) →
 * reserve hold → sign (verify-before-submit) → X-PAYMENT, state BROADCASTING. A DENY writes a
 * payment_events audit row and moves no money; a replayed (paymentId,resourceId) never double-reserves.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;
const CHAIN_ID = 421_614;
const TOKEN: Address = '0x5555555555555555555555555555555555555555';
const VENDOR = '0x4444444444444444444444444444444444444444';
const RESOURCE = 'svc:weather';

// Well-known public anvil test keys — NOT secrets; throwaway, local signing only.
const agentFloat = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const treasury = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const signer = new LocalKmsSigner({ 'agent-float': agentFloat, 'treasury-allocation': treasury });

// EIP-5267 seam stub: simulates the on-chain eip712Domain() read for the token (USDC version "2").
const tokenDomainSource: TokenDomainSource = {
  readEip712Domain: ({ address }) =>
    Promise.resolve({ name: 'USD Coin', version: '2', chainId: BigInt(CHAIN_ID), verifyingContract: address }),
};

// E7 domain-binding stub (BUG-17): binds any vendor host to VENDOR so these spend-path tests pass step 4b.
const domainRegistry: DomainRegistry = { resolvePaymentAddress: () => Promise.resolve(VENDOR) };

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

const spendAt = (cap: number): SpendPolicy => ({
  spendCap: usdc(cap),
  perTransactionMax: usdc(1000), // high; the cap is what binds in these tests
  serviceScope: [RESOURCE], // ALLOWLIST must contain the quote's resource
  railPermission: ['raw-x402'],
  velocityLimitPerHour: 10,
});

const alloc: AllocationPolicy = {
  totalBudget: usdc(200),
  perAgentMax: usdc(10),
  cooldownSeconds: 0,
  allowedDestinations: [VENDOR],
};

function quoteFor(amount: bigint): Quote {
  return {
    resourceId: RESOURCE,
    amount,
    asset: 'USDC',
    rail: { scheme: 'raw-x402', chain: 'arc' },
    destination: VENDOR,
    verifyingContract: TOKEN,
    x402Scheme: 'exact',
    x402Network: 'arc-testnet',
    originHost: 'api.weather.example',
    validBefore: NOW + 600,
  };
}

let pgc: StartedPostgreSqlContainer | undefined;
let redisc: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;
let redis: Redis | undefined;
let deps: EnforceDeps | undefined;
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
    deps = { pool, redis, signer, tokenDomainSource, domainRegistry, chainId: CHAIN_ID };
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

/** Seed a fresh org+agent with an org-scoped spend (cap=$cap) + allocation policy, cache made fresh. */
async function seed(p: pg.Pool, r: Redis, cap: number): Promise<{ orgId: string; agentId: string }> {
  const org = await createOrg(p, { name: 'Acme', adminKeyHash: issueAdminKey().hash });
  const { agent } = await registerAgent(p, { orgId: org.id });
  const sp = await createPolicyVersion(p, { orgId: org.id, class: 'spend', rules: spendAt(cap) });
  const ap = await createPolicyVersion(p, { orgId: org.id, class: 'allocation', rules: alloc });
  await assignPolicy(p, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: sp.policyId, class: 'spend' });
  await assignPolicy(p, { orgId: org.id, scope: 'org', scopeId: org.id, policyId: ap.policyId, class: 'allocation' });
  const eff = await recompileAgentPolicy(p, r, agent.id);
  await bumpOrgEpoch(r, org.id, eff.policyEpoch);
  return { orgId: org.id, agentId: agent.id };
}

describe('enforceSpend — hot-path spine: allow, grant dedup, deny, kill-switch', () => {
  it('ALLOWs within cap: reserves the hold, returns a recoverable X-PAYMENT, persists BROADCASTING', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis || !deps) return skip();
    const { orgId, agentId } = await seed(pool, redis, 10);

    const res = await enforceSpend(deps, {
      agentId,
      orgId,
      quote: quoteFor(usdc(5)),
      fromAddress: agentFloat.address,
      paymentId: 'pay_allow',
      now: NOW,
    });

    expect(res.outcome).toBe('ALLOW');
    if (res.outcome !== 'ALLOW') return;

    // The hold is counted immediately (hold-inclusive).
    expect(await redis.get(keys.reserved(agentId))).toBe(usdc(5).toString());

    // The X-PAYMENT carries an authorization that recovers to the agent-float address.
    const decoded = decodeXPayment(res.xPayment);
    expect(decoded.payload.authorization.from).toBe(agentFloat.address);
    expect(decoded.payload.authorization.value).toBe(usdc(5).toString());
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: TOKEN },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: decoded.payload.authorization.from,
        to: decoded.payload.authorization.to,
        value: BigInt(decoded.payload.authorization.value),
        validAfter: BigInt(decoded.payload.authorization.validAfter),
        validBefore: BigInt(decoded.payload.authorization.validBefore),
        nonce: decoded.payload.authorization.nonce,
      },
      signature: decoded.payload.signature,
    });
    expect(recovered).toBe(agentFloat.address);

    // The in-flight BROADCASTING record carries the ephemeral nonce EXPIRY_CHECK will reconcile by.
    expect(await redis.exists(keys.payment('pay_allow'))).toBe(1);
    expect(await redis.hget(keys.payment('pay_allow'), 'nonce')).toBe(decoded.payload.authorization.nonce);
  });

  it('DEDUPs a replayed (paymentId,resourceId): DUPLICATE, no second reserve', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis || !deps) return skip();
    const { orgId, agentId } = await seed(pool, redis, 10);

    const first = await enforceSpend(deps, {
      agentId,
      orgId,
      quote: quoteFor(usdc(5)),
      fromAddress: agentFloat.address,
      paymentId: 'pay_dup',
      now: NOW,
    });
    expect(first.outcome).toBe('ALLOW');
    expect(await redis.get(keys.reserved(agentId))).toBe(usdc(5).toString());

    const replay = await enforceSpend(deps, {
      agentId,
      orgId,
      quote: quoteFor(usdc(5)),
      fromAddress: agentFloat.address,
      paymentId: 'pay_dup', // same payment + resource → grant already claimed
      now: NOW,
    });
    expect(replay).toEqual({ outcome: 'DUPLICATE', paymentId: 'pay_dup' });
    // The reserved counter is unchanged — the replay never placed a second hold.
    expect(await redis.get(keys.reserved(agentId))).toBe(usdc(5).toString());
  });

  it('DENIEs a spend over the cap (spend_cap_exceeded): no hold, audit row written', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis || !deps) return skip();
    const { orgId, agentId } = await seed(pool, redis, 10);

    const res = await enforceSpend(deps, {
      agentId,
      orgId,
      quote: quoteFor(usdc(12)), // 12 > cap 10
      fromAddress: agentFloat.address,
      paymentId: 'pay_deny',
      now: NOW,
    });
    expect(res).toEqual({ outcome: 'DENY', reason: 'spend_cap_exceeded' });

    // No money moved: no hold reserved, no grant claimed.
    expect(await redis.get(keys.reserved(agentId))).toBeNull();
    expect(await redis.exists(keys.grantClaim('pay_deny', RESOURCE))).toBe(0);

    // A DENY audit row exists (settlement_timestamp NULL, consumed 0).
    const row = await pool.query<{ result: string; reason_code: string; state: string; consumed: string; settlement_timestamp: Date | null }>(
      'SELECT result, reason_code, state, consumed, settlement_timestamp FROM payment_events WHERE payment_id = $1',
      ['pay_deny'],
    );
    expect(row.rows[0]?.result).toBe('DENY');
    expect(row.rows[0]?.reason_code).toBe('spend_cap_exceeded');
    expect(row.rows[0]?.consumed).toBe('0');
    expect(row.rows[0]?.settlement_timestamp).toBeNull();
  });

  it('short-circuits a suspended org to org_suspended BEFORE any reserve (kill-switch)', async ({ skip }) => {
    if (!dockerAvailable || !pool || !redis || !deps) return skip();
    const { orgId, agentId } = await seed(pool, redis, 10);
    await redis.set(keys.denyAll(orgId), '1');

    const res = await enforceSpend(deps, {
      agentId,
      orgId,
      quote: quoteFor(usdc(5)),
      fromAddress: agentFloat.address,
      paymentId: 'pay_suspended',
      now: NOW,
    });
    expect(res).toEqual({ outcome: 'DENY', reason: 'org_suspended' });
    expect(await redis.get(keys.reserved(agentId))).toBeNull();

    const row = await pool.query<{ result: string; reason_code: string }>(
      'SELECT result, reason_code FROM payment_events WHERE payment_id = $1',
      ['pay_suspended'],
    );
    expect(row.rows[0]?.result).toBe('DENY');
    expect(row.rows[0]?.reason_code).toBe('org_suspended');
  });
});
