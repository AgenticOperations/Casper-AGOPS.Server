import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

/**
 * Redis client (the hot tier: enforcement decisions, ledger-hot holds, grant dedup).
 *
 * Durability is an explicit requirement (NFR-02): the server assumes the Redis it
 * connects to has AOF enabled (see docker-compose.yml / SPIKE-06). The client does
 * not silently degrade — a hot-path store that loses an acknowledged hold is a
 * correctness bug, not a performance one.
 */
export function createRedis(env: Pick<Env, 'REDIS_URL'>): Redis {
  const client = new Redis(env.REDIS_URL, {
    // Fail-closed posture: do not buffer commands against a down server on the hot path.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  return client;
}

/** Liveness probe used by /healthz. Returns true iff PING replies PONG. */
export async function pingRedis(client: Redis): Promise<boolean> {
  if (client.status !== 'ready' && client.status !== 'connecting') {
    await client.connect();
  }
  const pong = await client.ping();
  return pong === 'PONG';
}
