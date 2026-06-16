import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authForRoute } from '../access/route-guard.js';
import { registerAgent, renameAgent, retireAgent, rotateAgentKey } from '../../control/store.js';

/**
 * Agent lifecycle (admin+). Wires the existing control/store.registerAgent (until now only reachable via
 * the demo bootstrap + tests) to a real API surface:
 *   POST   /v1/agents              — create + name an agent; returns the ag_ key ONCE (hash-only persisted).
 *   PATCH  /v1/agents/:id          — rename.
 *   POST   /v1/agents/:id/retire   — terminal status flip; the agent's ag_ stops authorizing on the hot path.
 *   POST   /v1/agents/:id/rotate-key — mint a new ag_ (returned once); the old hash is replaced, so the
 *                                     previous token stops authorizing immediately.
 *
 * Every route is tenant-fenced to the principal's org (cross-org mutation → 404, never leaking existence)
 * and floors at admin (member → 403, no credential → 401). The raw ag_ is returned ONLY on create + rotate,
 * ONLY once, and is never logged (the response body is not serialized to the access log).
 */
const CreateBody = z.object({ name: z.string().min(1).max(200), team_id: z.string().optional() });
const RenameBody = z.object({ name: z.string().min(1).max(200) });

export function registerAgentLifecycleRoutes(app: FastifyInstance): void {
  app.post('/v1/agents', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const { agent, apiKey } = await registerAgent(pool, {
      orgId: auth.principal.orgId,
      name: parsed.data.name,
      ...(parsed.data.team_id ? { teamId: parsed.data.team_id } : {}),
    });
    return reply.code(201).send({
      agent: { id: agent.id, name: agent.name, org_id: agent.orgId, status: agent.status },
      api_key: apiKey.token, // shown ONCE
    });
  });

  app.patch('/v1/agents/:id', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id } = request.params as { id: string };
    const parsed = RenameBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const ok = await renameAgent(pool, auth.principal.orgId, id, parsed.data.name);
    if (!ok) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.code(200).send({ agent: { id, name: parsed.data.name } });
  });

  app.post('/v1/agents/:id/retire', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id } = request.params as { id: string };

    const ok = await retireAgent(pool, auth.principal.orgId, id);
    if (!ok) return reply.code(404).send({ error: 'agent_not_found_or_already_retired' });
    return reply.code(200).send({ agent: { id, status: 'retired' } });
  });

  app.post('/v1/agents/:id/rotate-key', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id } = request.params as { id: string };

    const rotated = await rotateAgentKey(pool, auth.principal.orgId, id);
    if (!rotated) return reply.code(404).send({ error: 'agent_not_found' });
    return reply.code(200).send({ agent: { id }, api_key: rotated.token }); // shown ONCE
  });
}
