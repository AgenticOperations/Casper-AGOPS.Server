import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authForRoute } from './route-guard.js';
import { issueApiKey, listApiKeys, revokeApiKey } from './api-key-store.js';

/**
 * Org API-key lifecycle (admin+). Keys are machine credentials: the raw sk_ is returned exactly once at
 * issue and NEVER again — listings are masked (never the hash or the raw key). All three routes are
 * tenant-fenced to the path :id via authForRoute(forOrgId): a principal that does not own that org gets
 * 404 (no cross-org existence leak), so a key belonging to another org can be neither revealed nor revoked.
 * A member (read-only) is 403 here; only admin+ may mint/list/revoke keys.
 */
const IssueBody = z.object({ label: z.string().max(200).optional() });

export function registerApiKeyRoutes(app: FastifyInstance): void {
  app.post('/v1/orgs/:id/api-keys', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId } = request.params as { id: string };
    const auth = await authForRoute(app, request, 'admin', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = IssueBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const createdBy = auth.principal.actorType === 'user' ? (auth.principal.userId ?? null) : null;
    const { record, token } = await issueApiKey(pool, {
      orgId,
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      createdBy,
    });
    return reply.code(201).send({
      api_key: token, // shown ONCE — never logged, never returned again
      key: { id: record.id, label: record.label, prefix: record.prefix, created_at: record.createdAt },
    });
  });

  app.get('/v1/orgs/:id/api-keys', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId } = request.params as { id: string };
    const auth = await authForRoute(app, request, 'admin', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const keys = await listApiKeys(pool, orgId);
    return reply.code(200).send({
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        prefix: k.prefix,
        masked: `${k.prefix}_${'•'.repeat(8)}`, // masked — never the raw key, never the hash
        created_at: k.createdAt,
        last_used_at: k.lastUsedAt,
        revoked_at: k.revokedAt,
        revoked: k.revokedAt !== null,
      })),
    });
  });

  app.delete('/v1/orgs/:id/api-keys/:keyId', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId, keyId } = request.params as { id: string; keyId: string };
    const auth = await authForRoute(app, request, 'admin', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    // Tenant-fenced UPDATE: revokes only a LIVE key in THIS org. A cross-org keyId, an unknown id, or an
    // already-revoked key all match nothing → 404 (no cross-tenant reveal, no double-revoke side effect).
    const revoked = await revokeApiKey(pool, orgId, keyId);
    if (!revoked) return reply.code(404).send({ error: 'api_key_not_found' });
    return reply.code(204).send();
  });
}
