import type { FastifyInstance } from 'fastify';
import { authForRoute } from '../identity/access/route-guard.js';
import { isOrgSuspended } from './kill-switch.js';
import { keys } from '../../redis/keyspace.js';

/**
 * E1 Control — Group A read surface (doc 05 §9). Phase-1 F0 ships ONLY the org summary the console shell
 * reads on entry: org header + the DENY_ALL state + the committed-budget total. Admin-key authed via the
 * shared `authenticateAdmin` and tenant-fenced — the path `:id` must match the org the `sk_live_` key
 * owns, else 404 (no cross-org existence leak). Off the agent hot path. Money is base-units serialized as
 * a decimal STRING — never a float / never a JS number (doc 03 money invariant).
 */
export function registerControlRoutes(app: FastifyInstance): void {
  app.get('/v1/orgs/:id/summary', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const { id } = request.params as { id: string };
    // Read surface → member+. The guard tenant-fences to the path `:id`: a principal that does not own
    // that org gets 404 (no cross-org existence leak), preserving the prior fence contract.
    const auth = await authForRoute(app, request, 'member', id);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const orgId = auth.principal.orgId;

    const orgRes = await pool.query<{ name: string; policy_epoch: number }>(
      'SELECT name, policy_epoch FROM orgs WHERE id = $1',
      [orgId],
    );
    const org = orgRes.rows[0];
    if (!org) return reply.code(404).send({ error: 'org_not_found' });

    const [denyAll, committed] = await Promise.all([
      isOrgSuspended(redis, orgId),
      redis.get(keys.allocationCommitted(orgId)),
    ]);

    return reply.code(200).send({
      org: { id: orgId, name: org.name },
      deny_all: denyAll,
      totals: {
        allocation_committed: committed ?? '0',
        policy_epoch: org.policy_epoch,
      },
    });
  });
}
