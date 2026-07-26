import type { Redis } from 'ioredis';
import type pg from 'pg';
import { keys } from '../../redis/keyspace.js';

/**
 * P1-owned graded-response actuators (engine-specs-FINAL.md:80,256, BUG-15). Monitoring REQUESTS; P1
 * (the operator's `sk_live_` admin authority) ACTUATES — Monitoring never writes spend-state directly.
 * The READ gates already exist: enforce.ts:113 (P3-A) and allocation-eval.ts:64 (P3-B) test `denyAll`;
 * auth.ts:56 refuses a suspended agent. This module is only the set/clear half.
 */

// Tier 3 — org DENY_ALL. The single Redis overwrite primitive (:80). NO TTL: fail-closed, lifted only by
// an explicit clear (:256). Freezes P3-A AND P3-B (:128). Presence is the whole signal (value is a marker).
export async function setOrgKillSwitch(redis: Redis, orgId: string): Promise<void> {
  await redis.set(keys.denyAll(orgId), '1');
}

export async function clearOrgKillSwitch(redis: Redis, orgId: string): Promise<void> {
  await redis.del(keys.denyAll(orgId));
}

export async function isOrgSuspended(redis: Redis, orgId: string): Promise<boolean> {
  return (await redis.exists(keys.denyAll(orgId))) === 1;
}

// Tier 2 — per-agent suspend. Tenant-fenced (org isolation, :268): the UPDATE matches on (id, org_id), so
// an operator can only act within their own org and an unknown id is a no-op. Returns whether a row
// matched (idempotent: re-suspending an already-suspended agent still matches its row → true).
export async function suspendAgent(
  pool: pg.Pool,
  p: { agentId: string; orgId: string },
): Promise<boolean> {
  const res = await pool.query(`UPDATE agents SET status = 'suspended' WHERE id = $1 AND org_id = $2`, [
    p.agentId,
    p.orgId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

export async function reinstateAgent(
  pool: pg.Pool,
  p: { agentId: string; orgId: string },
): Promise<boolean> {
  const res = await pool.query(`UPDATE agents SET status = 'active' WHERE id = $1 AND org_id = $2`, [
    p.agentId,
    p.orgId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

// Tier-2 read gate for the casper-guard (live) authorize path. Tenant-fenced same as suspendAgent:
// the SELECT matches on (id, org_id), so a cross-org id or an unknown id both read as not-suspended.
export async function isAgentSuspended(
  pool: pg.Pool,
  p: { agentId: string; orgId: string },
): Promise<boolean> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM agents WHERE id = $1 AND org_id = $2`,
    [p.agentId, p.orgId],
  );
  return res.rows[0]?.status === 'suspended';
}
