import type { Redis } from 'ioredis';
import { SPEND_WINDOW_SECONDS, keys, type SpendWindow } from '../../redis/keyspace.js';
import {
  RESERVE_LUA,
  RESERVE_WITH_POLICY_LUA,
  WINDOW_SUM_LUA,
  SETTLE_LUA,
  RELEASE_LUA,
} from '../../redis/lua/load.js';
import type { WindowSnapshot } from './types.js';

/**
 * Snapshot the lower boundary of every spend window at QUOTED time (BUG-14).
 *
 * Each window is a tumbling bucket of fixed width; the boundary is the bucket start
 * `floor(now / W) * W`. This value is captured at QUOTED and reused at settlement: even if the
 * bucket rolls over before the payment settles, the deduction still lands in the quoted bucket,
 * so a near-boundary hold can never escape its window (policy-engine-FINAL.md:241-249). The hold's
 * ZSET score is its own enforcement timestamp; this boundary is the `ZRANGEBYSCORE` lower bound.
 *
 * `nowSeconds` is integer Unix seconds (the QUOTED enforcement time).
 */
export function snapshotWindows(nowSeconds: number): WindowSnapshot {
  const snapshot = {} as Record<SpendWindow, number>;
  for (const window of Object.keys(SPEND_WINDOW_SECONDS) as SpendWindow[]) {
    const width = SPEND_WINDOW_SECONDS[window];
    snapshot[window] = Math.floor(nowSeconds / width) * width;
  }
  return snapshot;
}

// ── Hot tier (Redis + Lua) ──────────────────────────────────────────────────────

/** The custom Lua commands `defineCommand` attaches to an ioredis client. */
interface LedgerCommands {
  reserveHold(
    window1h: string,
    window1d: string,
    window7d: string,
    window30d: string,
    amountsKey: string,
    reservedKey: string,
    reservedHoldsKey: string,
    paymentId: string,
    amount: string,
    enforcementTs: number,
  ): Promise<number>;
  reserveHoldWithinPolicy(
    window1h: string,
    window1d: string,
    window7d: string,
    window30d: string,
    amountsKey: string,
    reservedKey: string,
    reservedHoldsKey: string,
    floatConfirmedKey: string,
    consumedKey: string,
    paymentId: string,
    amount: string,
    enforcementTs: number,
    capWindowMinTs: number,
    spendCap: string,
    velocityWindowMinTs: number,
    velocityLimit: number,
    enforceSolvency: string,
  ): Promise<number>;
  windowSum(windowKey: string, amountsKey: string, minTs: number): Promise<Array<string | null>>;
  settleHold(
    reservedKey: string,
    reservedHoldsKey: string,
    amountsKey: string,
    settledHoldsKey: string,
    paymentId: string,
  ): Promise<number>;
  releaseHold(
    window1h: string,
    window1d: string,
    window7d: string,
    window30d: string,
    amountsKey: string,
    reservedKey: string,
    reservedHoldsKey: string,
    settledHoldsKey: string,
    paymentId: string,
  ): Promise<number>;
}
type LedgerRedis = Redis & LedgerCommands;

// `defineCommand` mutates the client; register each script exactly once per client.
const REGISTERED = new WeakSet<Redis>();

/** Idempotently attach the ledger Lua scripts to a client (ioredis runs them via EVALSHA). */
export function registerLedgerScripts(redis: Redis): void {
  if (REGISTERED.has(redis)) return;
  redis.defineCommand('reserveHold', { numberOfKeys: 7, lua: RESERVE_LUA });
  redis.defineCommand('reserveHoldWithinPolicy', { numberOfKeys: 9, lua: RESERVE_WITH_POLICY_LUA });
  redis.defineCommand('windowSum', { numberOfKeys: 2, lua: WINDOW_SUM_LUA });
  redis.defineCommand('settleHold', { numberOfKeys: 4, lua: SETTLE_LUA });
  redis.defineCommand('releaseHold', { numberOfKeys: 8, lua: RELEASE_LUA });
  REGISTERED.add(redis);
}

/**
 * Atomically reserve a hold: write it into all four spend windows + the amounts hash + the
 * reserved counter (engine-specs-FINAL.md:128). The hold counts against every window's cap
 * immediately (hold-inclusive, BUG-14). Idempotent — returns `true` on a fresh reserve, `false`
 * if the payment was already reserved (a replay never double-bumps the counters).
 *
 * `enforcementTs` is the QUOTED-time score; it is the same across all windows.
 */
export async function reserveHold(
  redis: Redis,
  params: { agentId: string; paymentId: string; amount: bigint; enforcementTs: number },
): Promise<boolean> {
  registerLedgerScripts(redis);
  const written = await (redis as LedgerRedis).reserveHold(
    keys.spendWindow(params.agentId, '1h'),
    keys.spendWindow(params.agentId, '1d'),
    keys.spendWindow(params.agentId, '7d'),
    keys.spendWindow(params.agentId, '30d'),
    keys.spendAmounts(params.agentId),
    keys.reserved(params.agentId),
    keys.reservedHolds(params.agentId),
    params.paymentId,
    params.amount.toString(),
    // Integer Unix-seconds score; truncate defensively so a fractional input can't skew the bucket.
    Math.trunc(params.enforcementTs),
  );
  return written === 1;
}

export type PolicyReserveResult =
  | 'reserved'
  | 'duplicate'
  | 'cap_exceeded'
  | 'velocity_exceeded'
  | 'insufficient_float';

/**
 * Atomically check hold-inclusive spend cap + 1h velocity + FLOAT SOLVENCY, then reserve the hold.
 * This is the policy-safe variant for new guarded rails: no caller may read a window sum and reserve
 * later.
 *
 * `spendCap` is a policy dial; `spendable = float_confirmed − consumed − reserved` is custody truth.
 * Both are enforced inside one Lua script, so concurrent authorizations cannot together overspend
 * either bound. Without the solvency leg an agent holding zero float could authorize payments and
 * receive paid data, since the guard's signature — not a balance — is what unlocks the vendor.
 *
 * `enforceSolvency: false` skips the balance leg for rails that are not float-backed. It is an
 * explicit per-call decision, never a default: see the caller in casper-guard/policy.ts.
 */
export async function reserveHoldWithinPolicy(
  redis: Redis,
  params: {
    agentId: string;
    paymentId: string;
    amount: bigint;
    enforcementTs: number;
    spendCap: bigint;
    velocityLimitPerHour: number;
    enforceSolvency: boolean;
  },
): Promise<PolicyReserveResult> {
  registerLedgerScripts(redis);
  const snapshot = snapshotWindows(params.enforcementTs);
  const result = await (redis as LedgerRedis).reserveHoldWithinPolicy(
    keys.spendWindow(params.agentId, '1h'),
    keys.spendWindow(params.agentId, '1d'),
    keys.spendWindow(params.agentId, '7d'),
    keys.spendWindow(params.agentId, '30d'),
    keys.spendAmounts(params.agentId),
    keys.reserved(params.agentId),
    keys.reservedHolds(params.agentId),
    keys.floatConfirmed(params.agentId),
    keys.consumed(params.agentId),
    params.paymentId,
    params.amount.toString(),
    Math.trunc(params.enforcementTs),
    snapshot['30d'],
    params.spendCap.toString(),
    snapshot['1h'],
    params.velocityLimitPerHour,
    params.enforceSolvency ? '1' : '0',
  );
  if (result === 1) return 'reserved';
  if (result === 0) return 'duplicate';
  if (result === -1) return 'cap_exceeded';
  if (result === -2) return 'velocity_exceeded';
  if (result === -3) return 'insufficient_float';
  throw new Error(`unexpected reserveHoldWithinPolicy result: ${result}`);
}

/**
 * Settle a hold in place (SETTLED): the spend stays counted in every window (committed = settled +
 * holds, BUG-14) but leaves the reserved counter (engine-specs-FINAL.md:153). Idempotent — returns
 * `true` if this call cleared the reserved contribution, `false` if it was already settled/released.
 */
export async function settleHold(
  redis: Redis,
  agentId: string,
  paymentId: string,
): Promise<boolean> {
  registerLedgerScripts(redis);
  const cleared = await (redis as LedgerRedis).settleHold(
    keys.reserved(agentId),
    keys.reservedHolds(agentId),
    keys.spendAmounts(agentId),
    keys.settledHolds(agentId),
    paymentId,
  );
  return cleared === 1;
}

/**
 * Release a hold (FAILED_TERMINAL / EXPIRED): the payment never happened, so it is removed from
 * every window and, if still outstanding, the reserved counter drops (engine-specs-FINAL.md:153).
 * Idempotent — returns `true` if a hold was removed, `false` if there was nothing to release.
 */
export async function releaseHold(
  redis: Redis,
  agentId: string,
  paymentId: string,
): Promise<boolean> {
  registerLedgerScripts(redis);
  const removed = await (redis as LedgerRedis).releaseHold(
    keys.spendWindow(agentId, '1h'),
    keys.spendWindow(agentId, '1d'),
    keys.spendWindow(agentId, '7d'),
    keys.spendWindow(agentId, '30d'),
    keys.spendAmounts(agentId),
    keys.reserved(agentId),
    keys.reservedHolds(agentId),
    keys.settledHolds(agentId),
    paymentId,
  );
  return removed === 1;
}

/**
 * Hold-inclusive sum of an agent's spend window: committed = SETTLED + outstanding holds
 * (policy-engine-FINAL.md:234-239). `minTs` is the snapshotted window lower bound from
 * {@link snapshotWindows}. The fetch is atomic; the amounts are summed here as bigints (exact —
 * USDC base-unit totals can exceed 2^53, which Lua doubles would round).
 */
export async function windowSum(
  redis: Redis,
  agentId: string,
  window: SpendWindow,
  minTs: number,
): Promise<bigint> {
  registerLedgerScripts(redis);
  const amounts = await (redis as LedgerRedis).windowSum(
    keys.spendWindow(agentId, window),
    keys.spendAmounts(agentId),
    minTs,
  );
  let sum = 0n;
  for (const amount of amounts) {
    if (amount !== null) sum += BigInt(amount);
  }
  return sum;
}
