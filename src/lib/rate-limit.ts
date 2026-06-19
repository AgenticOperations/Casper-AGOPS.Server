import type { Redis } from 'ioredis';
import { RATE_LIMIT_LUA } from '../redis/lua/load.js';

/**
 * Redis fixed-window limiter for auth-route abuse control. Reuses the existing ioredis client (no new
 * dependency) and the same Lua-loading convention as the hot tier (see src/redis/lua/load.ts), so the
 * build's copy-lua step ships the script to dist and the path resolves in dev (tsx/vitest) and prod
 * (node dist/) identically. Keyed per route-group + identifier (the caller passes client IP).
 *
 * This function is intentionally thin and may THROW if Redis is unavailable — the caller (the route
 * guard) decides the failure posture. For auth, that posture is FAIL-OPEN: a Redis hiccup must not lock
 * users out of login/register, so the guard catches, logs a warning, and allows the request.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  redis: Redis,
  key: string,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const res = (await redis.eval(
    RATE_LIMIT_LUA,
    1,
    key,
    String(opts.limit),
    String(opts.windowSeconds),
  )) as [number, number, number];
  // ttl is -1 (no expire) / -2 (no key) only in races; treat any non-positive ttl as a full window so
  // Retry-After is never zero or negative.
  const ttl = res[2];
  return {
    allowed: res[0] === 1,
    remaining: res[1],
    retryAfterSeconds: ttl > 0 ? ttl : opts.windowSeconds,
  };
}
