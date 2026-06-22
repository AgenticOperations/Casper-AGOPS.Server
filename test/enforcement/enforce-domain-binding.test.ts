import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enforceSpend, type EnforceDeps } from '../../src/engines/enforcement/enforce.js';
import { keys } from '../../src/redis/keyspace.js';
import { snapshotWindows, windowSum } from '../../src/engines/ledger/window.js';
import type { Quote } from '../../src/contracts/index.js';
import {
  startStores,
  stopStores,
  seedAgent,
  signer,
  tokenDomainSource,
  bindAnyTo,
  agentFloat,
  CHAIN_ID,
  RESOURCE,
  VENDOR,
  TOKEN,
  usdc,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * E7 Domain Binding gate on the spend spine (enforce.ts step 4b, BUG-17). A policy-valid spend whose
 * payTo does NOT match the vendor domain's published address is DENIED `destination_unverified` BEFORE
 * any reserve — a compromised agent cannot redirect funds to an attacker address even within its
 * SpendPolicy cap (the cap bounds the amount, the domain binding bounds the recipient). The deny path
 * moves no money (no hold, no grant, no BROADCASTING record) and writes exactly one audit row. A
 * matching payTo passes the gate and reaches the sign/ALLOW path.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;
const ATTACKER = '0x000000000000000000000000000000000000dEaD';

// Distinct hosts per case: the 5-min domain-binding cache is keyed by host and stores the DOMAIN's
// published address, so a real host resolves to one address — reusing a host across the mismatch and
// match cases would read a stale cache entry, not the per-case registry.
function arcQuote(amount: bigint, originHost: string): Quote {
  return {
    resourceId: RESOURCE,
    amount,
    asset: 'USDC',
    rail: { scheme: 'raw-x402', chain: 'arc' },
    destination: VENDOR,
    verifyingContract: TOKEN,
    x402Scheme: 'exact',
    x402Network: 'arc-testnet',
    originHost,
    validBefore: NOW + 600,
  };
}

function depsWith(s: Stores, registry: EnforceDeps['domainRegistry']): EnforceDeps {
  return {
    pool: s.pool,
    redis: s.redis,
    signer,
    tokenDomainSource,
    domainRegistry: registry,
    chainId: CHAIN_ID,
  };
}

let stores: Stores | null = null;

beforeAll(async () => {
  stores = await startStores();
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

describe('enforceSpend — step 4b domain binding (BUG-17)', () => {
  it('DENIES destination_unverified on a payTo/domain mismatch and moves no money', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId } = await seedAgent(pool, redis, 10);

    // The domain publishes ATTACKER, but the quote pays VENDOR → mismatch → fail-closed deny.
    const result = await enforceSpend(depsWith(stores, bindAnyTo(ATTACKER)), {
      agentId,
      orgId,
      quote: arcQuote(usdc(5), 'mismatch.vendor.test'),
      fromAddress: agentFloat.address,
      paymentId: 'pay_dv',
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'DENY', reason: 'destination_unverified' });
    // No money moved: no hold, no window contribution, no grant claim, no BROADCASTING record.
    expect((await redis.get(keys.reserved(agentId))) ?? '0').toBe('0');
    expect(await windowSum(redis, agentId, '1h', snapshotWindows(NOW)['1h'])).toBe(0n);
    expect(await redis.exists(keys.grantClaim('pay_dv', RESOURCE))).toBe(0);
    expect(await redis.exists(keys.payment('pay_dv'))).toBe(0);
    // Exactly one DENY audit row carrying the structured reason.
    const row = await pool.query(
      'SELECT result, reason_code FROM payment_events WHERE payment_id = $1',
      ['pay_dv'],
    );
    expect(row.rows).toEqual([{ result: 'DENY', reason_code: 'destination_unverified' }]);
  });

  it('passes the gate and ALLOWS when the vendor domain publishes the quote payTo', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId } = await seedAgent(pool, redis, 10);

    const result = await enforceSpend(depsWith(stores, bindAnyTo(VENDOR)), {
      agentId,
      orgId,
      quote: arcQuote(usdc(5), 'match.vendor.test'),
      fromAddress: agentFloat.address,
      paymentId: 'pay_ok',
      now: NOW,
    });

    expect(result.outcome).toBe('ALLOW');
    if (result.outcome === 'ALLOW') {
      expect(result.paymentId).toBe('pay_ok');
      expect(result.xPayment.length).toBeGreaterThan(0);
    }
    // The hold was placed and persisted: binding passed → reserve + sign ran (state BROADCASTING).
    expect(await redis.exists(keys.payment('pay_ok'))).toBe(1);
  });
});
