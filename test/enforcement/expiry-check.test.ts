import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enforceSpend, type EnforceDeps } from '../../src/engines/enforcement/enforce.js';
import {
  reconcile,
  readBroadcastingPayment,
  type NonceReconciler,
} from '../../src/engines/enforcement/expiry-check.js';
import { keys } from '../../src/redis/keyspace.js';
import { windowSum, snapshotWindows } from '../../src/engines/ledger/window.js';
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
 * EXPIRY_CHECK reconciler — the money-critical settle-or-expire band (engine-specs-FINAL.md, BUG-20/26).
 * agentOps SIGNS ONLY; a BROADCASTING hold reaches a terminal state ONLY by reading on-chain nonce
 * consumption, never on a network condition alone:
 *   - nonce consumed            → SETTLED  (settle the hold in place + write the ALLOW audit row)
 *   - unspent, past validBefore → EXPIRED  (release the hold; the authorization lapsed unused)
 *   - reconciler unavailable    → LOCKED   (NO state change, NO auto-release; operator alert)
 * The LOCKED no-blind-drop is the invariant: an unreadable chain never silently frees money.
 * Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;

function quoteFor(amount: bigint, validBefore: number): Quote {
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
    validBefore,
  };
}

const reconcilerReturning = (v: boolean | 'rpc_unavailable'): NonceReconciler => ({
  wasNonceConsumed: () => Promise.resolve(v),
});

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

/** Drive one ALLOW through enforceSpend to leave a BROADCASTING in-flight record to reconcile. */
async function broadcast(paymentId: string, amount: bigint): Promise<{ agentId: string }> {
  if (!stores || !deps) throw new Error('no stores');
  const { orgId, agentId } = await seedAgent(stores.pool, stores.redis, 10);
  const res = await enforceSpend(deps, {
    agentId,
    orgId,
    quote: quoteFor(amount, NOW + 600),
    fromAddress: agentFloat.address,
    paymentId,
    now: NOW,
  });
  expect(res.outcome).toBe('ALLOW');
  return { agentId };
}

describe('reconcile — settle on nonce consumption, expire when lapsed, never blind-drop', () => {
  it('SETTLES when the nonce was consumed: hold settled in place, ALLOW audit row, in-flight cleared', async ({
    skip,
  }) => {
    if (!stores || !deps) return skip();
    const { redis, pool } = stores;
    const { agentId } = await broadcast('pay_settle', usdc(5));

    const payment = await readBroadcastingPayment(redis, 'pay_settle');
    expect(payment).not.toBeNull();
    if (!payment) return;

    const outcome = await reconcile({ pool, redis, reconciler: reconcilerReturning(true) }, payment, NOW + 700);
    expect(outcome).toBe('SETTLED');

    // Reserved contribution cleared, but the spend stays counted in the window (committed).
    expect(Number((await redis.get(keys.reserved(agentId))) ?? '0')).toBe(0);
    expect(await windowSum(redis, agentId, '1h', snapshotWindows(NOW)['1h'])).toBe(usdc(5));

    // The settlement audit row exists (state SETTLED, result ALLOW, consumed = requested).
    const row = await pool.query<{ state: string; result: string; consumed: string }>(
      'SELECT state, result, consumed FROM payment_events WHERE payment_id = $1',
      ['pay_settle'],
    );
    expect(row.rows[0]?.state).toBe('SETTLED');
    expect(row.rows[0]?.result).toBe('ALLOW');
    expect(row.rows[0]?.consumed).toBe(usdc(5).toString());

    // The in-flight record is consumed (no re-reconciliation).
    expect(await redis.exists(keys.payment('pay_settle'))).toBe(0);
  });

  it('EXPIRES when unspent past validBefore: hold released, no settlement row', async ({ skip }) => {
    if (!stores || !deps) return skip();
    const { redis, pool } = stores;
    const { agentId } = await broadcast('pay_expire', usdc(5));

    const payment = await readBroadcastingPayment(redis, 'pay_expire');
    if (!payment) return expect(payment).not.toBeNull();

    const outcome = await reconcile(
      { pool, redis, reconciler: reconcilerReturning(false) },
      payment,
      NOW + 700, // strictly past validBefore (NOW + 600)
    );
    expect(outcome).toBe('EXPIRED');

    // The hold is gone from both the reserved counter and the window (it never happened).
    expect(Number((await redis.get(keys.reserved(agentId))) ?? '0')).toBe(0);
    expect(await windowSum(redis, agentId, '1h', snapshotWindows(NOW)['1h'])).toBe(0n);
    expect(await redis.exists(keys.payment('pay_expire'))).toBe(0);

    // No money moved → no settlement row.
    const row = await pool.query('SELECT 1 FROM payment_events WHERE payment_id = $1', ['pay_expire']);
    expect(row.rowCount).toBe(0);
  });

  it('is idempotent on double-reconcile: a second settle is a no-op, never a duplicate-key throw', async ({
    skip,
  }) => {
    if (!stores || !deps) return skip();
    const { redis, pool } = stores;
    await broadcast('pay_double', usdc(5));

    const payment = await readBroadcastingPayment(redis, 'pay_double');
    if (!payment) return expect(payment).not.toBeNull();

    // Two reconcile workers that both read the in-flight record before either deleted it: both see the
    // nonce consumed and both try to settle. The losing worker must be a no-op, not a PK-collision throw.
    const first = await reconcile({ pool, redis, reconciler: reconcilerReturning(true) }, payment, NOW + 700);
    expect(first).toBe('SETTLED');
    const second = await reconcile({ pool, redis, reconciler: reconcilerReturning(true) }, payment, NOW + 700);
    expect(second).toBe('SETTLED');

    // Exactly one settlement audit row — the append-only journal never doubles a settled spend.
    const row = await pool.query('SELECT 1 FROM payment_events WHERE payment_id = $1', ['pay_double']);
    expect(row.rowCount).toBe(1);
  });

  it('LOCKS when the chain read is unavailable: hold untouched, in-flight preserved (no blind-drop)', async ({
    skip,
  }) => {
    if (!stores || !deps) return skip();
    const { redis, pool } = stores;
    const { agentId } = await broadcast('pay_locked', usdc(5));

    const payment = await readBroadcastingPayment(redis, 'pay_locked');
    if (!payment) return expect(payment).not.toBeNull();

    const outcome = await reconcile(
      { pool, redis, reconciler: reconcilerReturning('rpc_unavailable') },
      payment,
      NOW + 700,
    );
    expect(outcome).toBe('LOCKED');

    // BUG-20/26: an unreadable chain NEVER releases the hold and NEVER drops the in-flight record.
    expect((await redis.get(keys.reserved(agentId))) ?? '0').toBe(usdc(5).toString());
    expect(await redis.exists(keys.payment('pay_locked'))).toBe(1);
    expect(await redis.hget(keys.payment('pay_locked'), 'state')).toBe('BROADCASTING');

    const row = await pool.query('SELECT 1 FROM payment_events WHERE payment_id = $1', ['pay_locked']);
    expect(row.rowCount).toBe(0);
  });
});
