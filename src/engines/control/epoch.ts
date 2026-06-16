import type { Redis } from 'ioredis';
import { keys } from '../../redis/keyspace.js';
import { EPOCH_BUMP_LUA } from '../../redis/lua/load.js';

/**
 * The per-org `policy_epoch` counter in Redis — the instant signal the P3-A stale-cache guard
 * (NFR-03) compares an effective_policy blob against. Postgres `orgs.policy_epoch` is the source of
 * truth; this counter mirrors it so the hot path reads "the org's current epoch" without touching
 * Postgres. The mirror is a high-water mark (monotonic `set-if-greater`, see `epoch-bump.lua`) so a
 * late lower write can never drop the current epoch and let a stale blob through.
 */

interface EpochCommands {
  bumpOrgEpoch(counterKey: string, epoch: number): Promise<number>;
}
type EpochRedis = Redis & EpochCommands;

// `defineCommand` mutates the client; register the script exactly once per client.
const REGISTERED = new WeakSet<Redis>();

/** Idempotently attach the epoch-bump Lua script to a client (ioredis runs it via EVALSHA). */
export function registerEpochScript(redis: Redis): void {
  if (REGISTERED.has(redis)) return;
  redis.defineCommand('bumpOrgEpoch', { numberOfKeys: 1, lua: EPOCH_BUMP_LUA });
  REGISTERED.add(redis);
}

/**
 * Advance the org's policy-epoch counter to `epoch` if (and only if) `epoch` is greater than the
 * stored value. Returns `true` when the counter advanced, `false` when the candidate was not newer
 * (a replay or an out-of-order lower write). Monotonic by construction.
 */
export async function bumpOrgEpoch(redis: Redis, orgId: string, epoch: number): Promise<boolean> {
  registerEpochScript(redis);
  const advanced = await (redis as EpochRedis).bumpOrgEpoch(
    keys.policyEpoch(orgId),
    Math.trunc(epoch),
  );
  return advanced === 1;
}

/**
 * Read the org's current policy epoch from the Redis mirror. `null` means the counter is unset
 * (no edit has propagated yet); the guard treats that as "current epoch unknown" and recompiles
 * against Postgres rather than trusting a possibly-stale blob.
 */
export async function readOrgEpoch(redis: Redis, orgId: string): Promise<number | null> {
  const raw = await redis.get(keys.policyEpoch(orgId));
  return raw === null ? null : Number(raw);
}
