import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { EffectivePolicy } from '../../contracts/index.js';
import { bumpOrgEpoch, readOrgEpoch } from '../control/epoch.js';
import { readEffectivePolicy, recompileAgentPolicy } from '../control/publish.js';

/**
 * P3-A stale-cache guard (NFR-03, PHASE-1-NFR-CHECKLIST.md:35-40).
 *
 * The cheap, common path is a cache hit: read the agent's compiled `effective_policy` blob and the
 * org's current epoch from Redis; if the blob is at least as new as the current epoch, decide on it
 * directly. The blob is only stale during the propagation tail — the window between an edit bumping
 * the org epoch and the per-agent rewrite reaching this agent. In that window (or on a cache miss,
 * or when the current epoch is unknown), the guard recompiles this one agent inline against
 * Postgres (the source of truth), republishes the fresh blob, self-heals the epoch counter, and
 * decides on the new version — all within the hot-path budget (SPIKE-05 measures the cost).
 */
export interface PolicyResolution {
  policy: EffectivePolicy;
  /** True when an inline recompile fired (stale epoch, cache miss, or unknown current epoch). */
  recompiled: boolean;
}

/**
 * The money-critical staleness decision, isolated as a pure predicate so it can be exhaustively
 * unit-tested without a container runtime (the integration tests that exercise the full Redis/PG
 * path skip when Docker is absent; this comparison must never go unasserted).
 *
 * A cached blob is fresh only when we know the org's current epoch AND the blob is not behind it.
 * `>=` (not `==`) because a self-healed blob can briefly be newer than a lagging counter; a blob at
 * least as new as the high-water counter was compiled from a Postgres epoch at least as new as the
 * newest mirrored edit, so it is always safe to serve. A null blob or null current fails closed.
 */
export function isCacheFresh(
  blob: EffectivePolicy | null,
  currentEpoch: number | null,
): blob is EffectivePolicy {
  return blob !== null && currentEpoch !== null && blob.policyEpoch >= currentEpoch;
}

export async function resolveEffectivePolicy(
  pool: pg.Pool,
  redis: Redis,
  params: { agentId: string; orgId: string },
): Promise<PolicyResolution> {
  const [blob, current] = await Promise.all([
    readEffectivePolicy(redis, params.agentId),
    readOrgEpoch(redis, params.orgId),
  ]);

  if (isCacheFresh(blob, current)) {
    return { policy: blob, recompiled: false };
  }

  // Stale / missing / current-unknown → fail toward freshness: recompile against Postgres.
  // Benign known window: if a tighter edit commits between this recompile's REPEATABLE READ
  // snapshot and the republish, the just-published blob can trail the counter by one epoch — the
  // `isCacheFresh` `>=` check rejects it on the next request and recompiles once more. That costs a
  // redundant recompile, never a stale serve (a lower-epoch blob can never pass the guard).
  const fresh = await recompileAgentPolicy(pool, redis, params.agentId);
  // Self-heal the counter so a forgotten edit-time bump can't strand the org recompiling forever.
  // Monotonic, so this only ever advances it.
  await bumpOrgEpoch(redis, params.orgId, fresh.policyEpoch);
  return { policy: fresh, recompiled: true };
}
