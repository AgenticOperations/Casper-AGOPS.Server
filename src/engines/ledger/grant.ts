import type { Redis } from 'ioredis';
import { keys } from '../../redis/keyspace.js';

/**
 * Grant-state is a set-if-not-exists store keyed on (paymentId, resourceId): the global dedup that
 * guarantees a delivered resource is claimed exactly once. `SET … NX EX` is atomic, so two racing
 * deliveries of the same payment cannot both win.
 *
 * The TTL bounds the claim to the payment's validity window — long enough to cover delivery, short
 * enough that the key does not accumulate forever. The full enforcement anchor (claim before
 * deliver, then settle) is wired in M5; this is the primitive it builds on.
 *
 * Returns `true` if this caller won the claim, `false` if the pair was already claimed.
 */
export async function claimGrant(
  redis: Redis,
  paymentId: string,
  resourceId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const reply = await redis.set(keys.grantClaim(paymentId, resourceId), '1', 'EX', ttlSeconds, 'NX');
  return reply === 'OK';
}
