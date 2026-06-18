import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Address, Hex } from 'viem';
import type { Rail } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';
import { releaseHold, settleHold } from '../ledger/window.js';
import { recordSettlement } from '../ledger/events.js';

/**
 * EXPIRY_CHECK reconciler — the band that moves a BROADCASTING payment to a terminal state
 * (engine-specs-FINAL.md:54-60, BUG-20/26/42). agentOps SIGNS ONLY and never broadcasts, so it can
 * never learn the on-chain result from its own action. It learns it the only safe way: by reading
 * whether the EIP-3009 authorization nonce was consumed on-chain.
 *
 *   - nonce consumed            → SETTLED  (settle the hold in place; write the ALLOW audit row)
 *   - unspent, past validBefore → EXPIRED  (release the hold; the authorization lapsed unused)
 *   - read unavailable          → LOCKED   (NO state change, NO auto-release; operator alert)
 *
 * The LOCKED case is the money-critical invariant: a transient RPC failure must NEVER be read as
 * "didn't happen" and silently free a hold that may already have settled on-chain (BUG-20/26). The
 * hold and the in-flight record are preserved so a later read can resolve it.
 *
 * The on-chain read is a seam ({@link NonceReconciler}) so this whole band is unit-testable with a
 * mock; the viem-backed implementation drops in at L8.
 */

/**
 * On-chain read seam: was this authorization nonce already consumed on the token contract?
 * `token` is the EIP-3009 contract (the quote's verifyingContract); `authorizer` is the float wallet
 * that signed. Returns `'rpc_unavailable'` when the chain cannot be read — never a false `false`.
 */
export interface NonceReconciler {
  wasNonceConsumed(params: {
    token: Address;
    authorizer: Address;
    nonce: Hex;
  }): Promise<boolean | 'rpc_unavailable'>;
}

export interface ReconcileDeps {
  pool: pg.Pool;
  redis: Redis;
  reconciler: NonceReconciler;
  /** Optional operator-alert sink; the worker passes the app logger. */
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

/** The in-flight record `enforceSpend` persists at BROADCASTING (everything settlement needs). */
export interface BroadcastingPayment {
  paymentId: string;
  agentId: string;
  orgId: string;
  rail: Rail;
  resourceId: string;
  destination: string;
  fromAddress: Address;
  /** The EIP-3009 contract the nonce lives on (the quote's verifyingContract). */
  verifyingContract: Address;
  nonce: Hex;
  requested: bigint;
  policyRef: string;
  validBefore: number;
  enforcementTs: number;
}

export type ReconcileOutcome = 'SETTLED' | 'EXPIRED' | 'LOCKED';

function field(hash: Record<string, string>, key: string): string {
  const value = hash[key];
  if (value === undefined) {
    throw new Error(`broadcasting payment record is missing field '${key}'`);
  }
  return value;
}

/** Load the BROADCASTING in-flight record `enforceSpend` persisted, or null if there is none. */
export async function readBroadcastingPayment(
  redis: Redis,
  paymentId: string,
): Promise<BroadcastingPayment | null> {
  const hash = await redis.hgetall(keys.payment(paymentId));
  if (Object.keys(hash).length === 0) return null;

  const railScheme = field(hash, 'rail_scheme');
  const railChain = field(hash, 'rail_chain');
  const rail: Rail =
    railScheme === 'circle-nano'
      ? { scheme: 'circle-nano', chain: 'arc' }
      : { scheme: 'raw-x402', chain: railChain === 'solana' ? 'solana' : 'arc' };

  return {
    paymentId,
    agentId: field(hash, 'agent_id'),
    orgId: field(hash, 'org_id'),
    rail,
    resourceId: field(hash, 'resource_id'),
    destination: field(hash, 'destination'),
    fromAddress: field(hash, 'from_address') as Address,
    verifyingContract: field(hash, 'verifying_contract') as Address,
    nonce: field(hash, 'nonce') as Hex,
    requested: BigInt(field(hash, 'requested')),
    policyRef: field(hash, 'policy_ref'),
    validBefore: Number(field(hash, 'valid_before')),
    enforcementTs: Number(field(hash, 'enforcement_ts')),
  };
}

/**
 * Reconcile one BROADCASTING payment. `now` is integer Unix seconds. This is the EXPIRY_CHECK band:
 * invoked once the authorization window has (or is about to) close. The nonce read is authoritative —
 * an unspent-but-not-yet-expired payment is left LOCKED (still in flight), never released early.
 */
export async function reconcile(
  deps: ReconcileDeps,
  payment: BroadcastingPayment,
  now: number,
): Promise<ReconcileOutcome> {
  const { redis, pool, reconciler } = deps;

  const consumed = await reconciler.wasNonceConsumed({
    token: payment.verifyingContract,
    authorizer: payment.fromAddress,
    nonce: payment.nonce,
  });

  // LOCKED: the chain is unreadable. Touch nothing — a hold that may have settled must not be freed.
  if (consumed === 'rpc_unavailable') {
    deps.logger?.warn(
      { paymentId: payment.paymentId, wallet: payment.fromAddress, reason: 'rpc_unavailable' },
      'expiry-check.locked: nonce reconciliation unavailable — hold preserved, NO auto-release',
    );
    return 'LOCKED';
  }

  // SETTLED: the authorization was consumed on-chain. Settle the hold in place (it stays counted in
  // the windows) and write the ALLOW settlement audit row. Phase-1 EIP-3009 transfers the full
  // authorized amount, so consumed == requested.
  if (consumed) {
    // settleHold is the atomic single-winner: exactly one caller clears the reserved contribution and
    // returns true. Gate the cold-tier settlement row on it so a concurrent (or replayed) reconcile is a
    // no-op rather than a duplicate-key INSERT — payment_events is keyed by payment_id (idempotent).
    const cleared = await settleHold(redis, payment.agentId, payment.paymentId);
    if (cleared) {
      await recordSettlement(pool, {
        paymentId: payment.paymentId,
        agentId: payment.agentId,
        orgId: payment.orgId,
        rail: payment.rail,
        resourceId: payment.resourceId,
        destination: payment.destination,
        requested: payment.requested,
        consumed: payment.requested,
        policyRef: payment.policyRef,
        enforcementTimestamp: new Date(payment.enforcementTs * 1000),
        settlementTimestamp: new Date(now * 1000),
      });
    }
    await redis.del(keys.payment(payment.paymentId));
    return 'SETTLED';
  }

  // Unspent. Only release once the authorization can no longer be used; otherwise it is still in
  // flight — keep the hold (no blind-drop) and let a later pass resolve it.
  if (now >= payment.validBefore) {
    await releaseHold(redis, payment.agentId, payment.paymentId);
    await redis.del(keys.payment(payment.paymentId));
    return 'EXPIRED';
  }

  deps.logger?.warn(
    { paymentId: payment.paymentId, validBefore: payment.validBefore, now, reason: 'not_yet_expired' },
    'expiry-check.locked: unspent but still within validity window — hold preserved',
  );
  return 'LOCKED';
}
