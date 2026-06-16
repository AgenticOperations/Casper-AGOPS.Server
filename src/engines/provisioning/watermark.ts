import type { Redis } from 'ioredis';
import { SPEND_WINDOW_SECONDS, type SpendWindow } from '../../redis/keyspace.js';
import { windowSum } from '../ledger/window.js';

/**
 * E5 dynamic replenishment watermark (policy-engine-FINAL.md:178, NFR-05).
 *
 *   watermark = max(STATIC_FLOOR, P × recent_burn)
 *
 * `recent_burn` is the agent's hold-inclusive spend over the last `window` (the P4 spend ZSET, read
 * through the same `windowSum` the enforcement hot path uses — one source of truth for "what has this
 * agent spent"). A high-velocity agent therefore earns a higher watermark, so `depositFor` (L2) is
 * triggered before the float runs dry: the dynamic term prevents the threshold stutter a flat floor would
 * cause for a busy agent, while the floor keeps a minimum cushion for an idle one.
 *
 * SPIKE-02 (do NOT freeze): `STATIC_FLOOR` and the multiplier `P` are NOT constants here — they are
 * parameters. SPIKE-02 calibrates them against simulated workload and records the chosen values in
 * `BUILD/technical-arch-impl-plans/spike-results.md` / `architecture/PHASE-1-SPIKES.md`. The replenishment
 * trigger that consumes `needsReplenish` is wired by the caller (M6 cron / hot path) once those land.
 */

/** Multiplier precision: P is applied as integer basis points so money stays exact (never a JS float). */
const MULTIPLIER_PRECISION = 10_000n;

export interface WatermarkParams {
  agentId: string;
  /** Unix seconds; the upper bound of the burn window (the burn window is `[now - W, now]`). */
  now: number;
  /** STATIC_FLOOR — the minimum cushion. A param, not a code constant (SPIKE-02 calibrates it). */
  staticFloor: bigint;
  /** P — the burn multiplier (e.g. 2 = 2×). A param, not a code constant (SPIKE-02 calibrates it). */
  multiplier: number;
  /** Burn window; defaults to the most reactive 1h window. */
  window?: SpendWindow;
}

/**
 * Compute the replenishment watermark for an agent. Returns base units. The multiplier is applied in
 * integer basis points (4 dp of precision on P), so the result is exact base-unit integer arithmetic —
 * USDC totals exceed 2^53 and must never pass through a JS float.
 */
export async function computeWatermark(redis: Redis, params: WatermarkParams): Promise<bigint> {
  const window: SpendWindow = params.window ?? '1h';
  const minTs = params.now - SPEND_WINDOW_SECONDS[window];
  const burn = await windowSum(redis, params.agentId, window, minTs);

  const basisPoints = BigInt(Math.round(params.multiplier * Number(MULTIPLIER_PRECISION)));
  const dynamic = (burn * basisPoints) / MULTIPLIER_PRECISION;

  return dynamic > params.staticFloor ? dynamic : params.staticFloor;
}

/** A float needs topping up when the spendable balance has fallen below its watermark. */
export function needsReplenish(spendable: bigint, watermark: bigint): boolean {
  return spendable < watermark;
}
