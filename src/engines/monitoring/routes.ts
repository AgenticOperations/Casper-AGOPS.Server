import type { FastifyInstance } from 'fastify';
import { authForRoute } from '../identity/access/route-guard.js';
import {
  setOrgKillSwitch,
  clearOrgKillSwitch,
  suspendAgent,
  reinstateAgent,
} from '../control/kill-switch.js';
import { readRecentDecisions, readDecisionsSince, tailNewDecisions, type DecisionEntry } from './telemetry.js';
import {
  CASPER_NETWORK_HEADER,
  resolveRequestNetwork,
  type CasperScopedNetwork,
} from '../casper-guard/network-header.js';

const CASPER_SCOPED_NETWORKS: readonly CasperScopedNetwork[] = ['casper:casper-test', 'casper:casper'];

/**
 * A decision belongs to the requested Casper network if its rail_chain is that network, OR if its
 * rail_chain is not a Casper network at all (e.g. 'arc', 'evm:sepolia') — non-Casper rails are shown
 * under both toggle positions since the Casper network toggle doesn't apply to them.
 */
function matchesRequestNetwork(entry: DecisionEntry, network: CasperScopedNetwork): boolean {
  if (!CASPER_SCOPED_NETWORKS.includes(entry.railChain as CasperScopedNetwork)) return true;
  return entry.railChain === network;
}

/**
 * E8 read-side surface + the P1-actuated control routes (engine-specs-FINAL.md:256,258). All routes are
 * org-scoped via the `sk_live_` admin key; the read feed respects org isolation (:268). NONE of these sit
 * on the agent hot path. The kill-switch / suspend routes are the operator (P1) actuation of the Tier-3 /
 * Tier-2 graded brakes; Monitoring surfaces, the operator actuates (BUG-15).
 */

function clampLimit(q: unknown): number {
  const raw = (q as { limit?: string } | undefined)?.limit;
  const n = raw ? Number(raw) : 50;
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.trunc(n));
}

function frame(d: DecisionEntry): string {
  return `id: ${d.id}\ndata: ${JSON.stringify(d)}\n\n`;
}

function lastEventId(request: { headers: Record<string, unknown>; query: unknown }): string | null {
  const header = request.headers['last-event-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  const q = (request.query as { last_event_id?: string } | undefined)?.last_event_id;
  return q && q.length > 0 ? q : null;
}

export function registerMonitoringRoutes(app: FastifyInstance): void {
  app.get('/v1/monitoring/decisions', async (request, reply) => {
    const { redis } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const decisions = (
      await readRecentDecisions(redis, auth.principal.orgId, clampLimit(request.query))
    ).filter((d) => matchesRequestNetwork(d, resolvedNetwork.network));
    return reply.code(200).send({ decisions });
  });

  /**
   * GET /v1/monitoring/decisions/stream
   *
   * Without `?follow=1`: bounded snapshot (ascending), closes after replay (F4.A1).
   * With `?follow=1`: replay backlog then hold the connection open, pushing each new decision as it
   * is XADDed via XREAD BLOCK on a dedicated connection (F4.A2). Tears down cleanly when the client
   * disconnects — no leaked Redis connection, no hanging Node handle. Off the hot path; additive to
   * the same stream key used by the snapshot branch.
   */
  app.get('/v1/monitoring/decisions/stream', async (request, reply) => {
    const { redis } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const orgId = auth.principal.orgId;

    const limit = clampLimit(request.query);
    const sinceId = lastEventId(request);
    const follow = (request.query as { follow?: string } | undefined)?.follow === '1';
    // ascending (oldest->newest) so a consumer replays chronologically and its Last-Event-ID advances.
    const backlog = sinceId
      ? await readDecisionsSince(redis, orgId, sinceId, limit)
      : [...(await readRecentDecisions(redis, orgId, limit))].reverse();
    const visibleBacklog = backlog.filter((d) => matchesRequestNetwork(d, resolvedNetwork.network));

    if (!follow) {
      reply.header('content-type', 'text/event-stream');
      reply.header('cache-control', 'no-cache');
      reply.header('x-accel-buffering', 'no');
      return reply.send(visibleBacklog.map(frame).join(''));
    }

    // Live tail. Hijack the socket; XREAD BLOCK on a dedicated connection until the client disconnects.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // cursor: newest backlog id → tail from there; or sinceId; or '$' (only entries arriving after subscribe).
    // Cursor advances from the UNFILTERED backlog/tail so an other-network entry is skipped from
    // display but never re-read on the next XREAD BLOCK.
    let cursor = backlog.length ? backlog[backlog.length - 1]!.id : (sinceId ?? '$');
    for (const d of visibleBacklog) res.write(frame(d));

    const sub = redis.duplicate();
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      sub.disconnect();
      try { res.end(); } catch { /* already ended */ }
    };
    request.raw.on('close', teardown);

    try {
      while (!closed) {
        const fresh = await tailNewDecisions(sub, orgId, cursor, 15_000);
        if (closed) break;
        if (fresh.length === 0) { res.write(': keep-alive\n\n'); continue; }
        for (const d of fresh) {
          if (matchesRequestNetwork(d, resolvedNetwork.network)) res.write(frame(d));
          cursor = d.id;
        }
      }
    } catch {
      // connection error → teardown; visibility degrades, payments unaffected.
    } finally {
      teardown();
    }
  });

  app.post('/v1/admin/kill-switch', async (request, reply) => {
    const { redis } = app.deps;
    // Tier-3 actuator (control-write) → admin+.
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    await setOrgKillSwitch(redis, auth.principal.orgId);
    return reply.code(200).send({ org_suspended: true });
  });

  app.delete('/v1/admin/kill-switch', async (request, reply) => {
    const { redis } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    await clearOrgKillSwitch(redis, auth.principal.orgId);
    return reply.code(200).send({ org_suspended: false });
  });

  app.post('/v1/admin/agents/:agentId/suspend', async (request, reply) => {
    const { pg: pool } = app.deps;
    // Tier-2 actuator (control-write) → admin+.
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { agentId } = request.params as { agentId: string };
    const changed = await suspendAgent(pool, { agentId, orgId: auth.principal.orgId });
    return changed
      ? reply.code(200).send({ suspended: true })
      : reply.code(404).send({ error: 'agent_not_found' });
  });

  app.delete('/v1/admin/agents/:agentId/suspend', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { agentId } = request.params as { agentId: string };
    const changed = await reinstateAgent(pool, { agentId, orgId: auth.principal.orgId });
    return changed
      ? reply.code(200).send({ suspended: false })
      : reply.code(404).send({ error: 'agent_not_found' });
  });
}
