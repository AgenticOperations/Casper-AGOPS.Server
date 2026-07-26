import type { FastifyInstance } from 'fastify';
import { authForRoute } from '../identity/access/route-guard.js';
import { resolvePeriod, readStatement, readAuditLog } from '../ledger/reports.js';
import { CASPER_NETWORK_HEADER, resolveRequestNetwork } from '../casper-guard/network-header.js';

/**
 * Group C — Reports (doc 05 §6.4, §9): read-side statements + the immutable audit-log export over the
 * append-only cold ledger. Org-scoped via the `sk_live_` admin key; never on the agent hot path; no write
 * path. On-chain reconciliation is a Phase-2 affordance (not built here).
 */

function clampAuditLimit(q: unknown): number {
  const raw = (q as { limit?: string } | undefined)?.limit;
  const n = raw ? Number(raw) : 500;
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(5000, Math.trunc(n));
}

export function registerReportsRoutes(app: FastifyInstance): void {
  app.get('/v1/reports/statement', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const period = resolvePeriod((request.query as { period?: string }).period, new Date());
    const statement = await readStatement(pool, auth.principal.orgId, period, resolvedNetwork.network);
    return reply.code(200).send({ statement });
  });

  app.get('/v1/reports/audit-log', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const q = request.query as { period?: string; limit?: string };
    const period = resolvePeriod(q.period, new Date());
    const rows = await readAuditLog(pool, auth.principal.orgId, period, clampAuditLimit(q), resolvedNetwork.network);
    return reply.code(200).send({
      rows,
      count: rows.length,
      period: { from: period.from, to: period.to, label: period.label },
    });
  });
}
