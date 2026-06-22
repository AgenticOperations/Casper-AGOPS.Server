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
 * Post-reserve failure compensation — the deny path must move no money in EVERY branch, including the
 * THROW branch. enforceSpend claims the grant and reserves the hold (steps 5-6) BEFORE it resolves the
 * EIP-712 domain and signs (step 7). If signing throws — a token whose EIP-5267 read fails and is
 * absent from knownTokens (UnsupportedTokenError), an unsupported settlement chain, or a verify-before-
 * submit mismatch — the hold and the grant must be rolled back. No spendable authorization ever leaves
 * the function on a throw, so the payment provably never happened: releasing the hold is correct (unlike
 * EXPIRY_CHECK, where a signed header DID leave and only an on-chain read may free it).
 *
 * Without the compensating release the hold leaks permanently: step 8 (the BROADCASTING record) never
 * runs, so EXPIRY_CHECK can never find the payment to reconcile, and the agent's budget is silently
 * reduced for up to 30 days while the reserved counter drifts forever.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;

/**
 * A quote whose settlement chain is Solana. Phase-1 signs Arc only, so `resolveQuoteDomain` throws
 * AFTER the grant claim + hold reserve — exercising the post-reserve failure path deterministically
 * (the production analogue is a token whose EIP-5267 read fails with no registry fallback).
 */
function solanaQuote(amount: bigint): Quote {
  return {
    resourceId: RESOURCE,
    amount,
    asset: 'USDC',
    rail: { scheme: 'raw-x402', chain: 'solana' },
    destination: VENDOR,
    verifyingContract: TOKEN,
    x402Scheme: 'exact',
    x402Network: 'solana-devnet',
    originHost: 'api.weather.example',
    validBefore: NOW + 600,
  };
}

let stores: Stores | null = null;
let deps: EnforceDeps | undefined;

beforeAll(async () => {
  stores = await startStores();
  if (stores) {
    deps = {
      pool: stores.pool,
      redis: stores.redis,
      signer,
      tokenDomainSource,
      domainRegistry: bindAnyTo(VENDOR),
      chainId: CHAIN_ID,
    };
  }
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

describe('enforceSpend — a post-reserve signing failure rolls back the hold and the grant', () => {
  it('releases the hold and clears the grant claim when signing throws (no orphaned budget)', async ({
    skip,
  }) => {
    if (!stores || !deps) return skip();
    const { redis } = stores;
    const { orgId, agentId } = await seedAgent(stores.pool, stores.redis, 10);

    // raw-x402 passes the rail permission (scheme is permitted; chain is not checked by P3-A), so the
    // grant is claimed and the hold reserved before resolveQuoteDomain throws on the solana chain.
    await expect(
      enforceSpend(deps, {
        agentId,
        orgId,
        quote: solanaQuote(usdc(5)),
        fromAddress: agentFloat.address,
        paymentId: 'pay_throw',
        now: NOW,
      }),
    ).rejects.toThrow();

    // The hold left no trace: reserved counter back to zero, removed from every window.
    expect((await redis.get(keys.reserved(agentId))) ?? '0').toBe('0');
    expect(await windowSum(redis, agentId, '1h', snapshotWindows(NOW)['1h'])).toBe(0n);

    // The grant claim is cleared (a fresh quote for the resource can be authorized again).
    expect(await redis.exists(keys.grantClaim('pay_throw', RESOURCE))).toBe(0);

    // The BROADCASTING record was never persisted (signing threw before step 8).
    expect(await redis.exists(keys.payment('pay_throw'))).toBe(0);
  });
});
