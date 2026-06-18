import type { Redis } from 'ioredis';
import { keys } from '../../redis/keyspace.js';
import type { DecisionTelemetry, DenyReason } from '../../contracts/index.js';

/**
 * E8 telemetry sink (engine-specs-FINAL.md:247-264). Monitoring is READ-SIDE and holds no authoritative
 * state (:262) — this stream is a rebuildable COPY (C-10 "async, copy", :60). The authoritative record is
 * the P4 `payment_events` audit row (ledger/events.ts). Two hard rules:
 *   1. it carries decision metadata only — no signature / X-PAYMENT bytes ever (BUG-31,
 *      policy-engine-FINAL.md:210); the {@link DecisionTelemetry} contract has no such field.
 *   2. it is FAIL-OPEN — a write failure NEVER propagates to the caller, so a telemetry/Monitoring
 *      outage can never block or fail a payment (engine-specs-FINAL.md:264). The inverse wiring is
 *      forbidden by spec.
 */

// Approximate cap: Monitoring holds no authoritative state and is rebuildable (:262), so the live tail is
// bounded; `~` lets Redis trim at radix-tree-node boundaries (cheap). Older history lives in P4 (pg).
const STREAM_MAXLEN = 1000;

export interface DecisionEntry extends DecisionTelemetry {
  /** Redis stream entry id. */
  id: string;
}

export async function emitDecisionSafe(redis: Redis, t: DecisionTelemetry): Promise<void> {
  try {
    const fields: string[] = ['payment_id', t.paymentId, 'agent_id', t.agentId, 'outcome', t.outcome];
    if (t.reason) fields.push('reason', t.reason);
    fields.push(
      'rail_scheme',
      t.railScheme,
      'rail_chain',
      t.railChain,
      'resource_id',
      t.resourceId,
      'amount',
      t.amount,
      'ts',
      String(t.ts),
    );
    await redis.xadd(keys.authorizeStream(t.orgId), 'MAXLEN', '~', STREAM_MAXLEN, '*', ...fields);
  } catch {
    // Fail-open (engine-specs-FINAL.md:264). Visibility degrades; the payment is unaffected.
  }
}

export function entryFrom(id: string, orgId: string, fields: string[]): DecisionEntry {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) m.set(fields[i] as string, fields[i + 1] as string);
  const outcome = (m.get('outcome') ?? 'DENY') as DecisionTelemetry['outcome'];
  const reason = m.get('reason');
  return {
    id,
    paymentId: m.get('payment_id') ?? '',
    agentId: m.get('agent_id') ?? '',
    orgId,
    outcome,
    ...(reason ? { reason: reason as DenyReason } : {}),
    railScheme: m.get('rail_scheme') ?? '',
    railChain: m.get('rail_chain') ?? '',
    resourceId: m.get('resource_id') ?? '',
    amount: m.get('amount') ?? '0',
    ts: Number(m.get('ts') ?? '0'),
  };
}

/** Read the most recent decisions for an org, newest-first (read-side dashboard/SSE source). */
export async function readRecentDecisions(
  redis: Redis,
  orgId: string,
  limit = 50,
): Promise<DecisionEntry[]> {
  const raw = (await redis.xrevrange(keys.authorizeStream(orgId), '+', '-', 'COUNT', limit)) as Array<
    [string, string[]]
  >;
  return raw.map(([id, fields]) => entryFrom(id, orgId, fields));
}

/**
 * Read decisions strictly AFTER a given stream id, ascending (oldest->newest). Used to resume an
 * SSE consumer from its `Last-Event-ID` without replaying the snapshot it already has.
 */
export async function readDecisionsSince(
  redis: Redis,
  orgId: string,
  sinceId: string,
  limit = 50,
): Promise<DecisionEntry[]> {
  const raw = (await redis.xrange(keys.authorizeStream(orgId), `(${sinceId}`, '+', 'COUNT', limit)) as Array<
    [string, string[]]
  >;
  return raw.map(([id, fields]) => entryFrom(id, orgId, fields));
}

/**
 * Block until at least one new decision lands after `cursor`, or `blockMs` elapses, then return the
 * new entries (ascending). Runs on a DEDICATED connection (XREAD BLOCK monopolizes it). Returns []
 * on timeout so the caller can emit a keep-alive and loop.
 */
export async function tailNewDecisions(
  sub: Redis,
  orgId: string,
  cursor: string,
  blockMs: number,
): Promise<DecisionEntry[]> {
  const got = await sub.xread('BLOCK', blockMs, 'STREAMS', keys.authorizeStream(orgId), cursor);
  if (!got) return [];
  const [, entries] = got[0]!;
  return entries.map(([id, fields]) => entryFrom(id, orgId, fields));
}
