import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { authForRoute } from '../../identity/access/route-guard.js';
import { promptToGraph, type GraphModelClient } from './prompt-to-graph.js';
import { deployGraph, GraphDeployError } from './deploy.js';
import { saveGraph, markGraphDeployed, getGraph, listGraphs } from './graph-store.js';
import { validateGraph } from './validate.js';
import { registerAgent, createPolicyVersion, assignPolicy } from '../store.js';
import { attachTradingFlow } from '../attach-trading-flow.js';

/**
 * H.1 — server-side endpoint wrapping promptToGraph(prompt). Auth follows the existing
 * member+ pattern (sk_ machine key or cookie). No signer/deploy/vault dependency is wired in
 * here or in promptToGraph.ts — see prompt-to-graph-safety.test.ts. If GEMINI_API_KEY is
 * unset, the endpoint 503s honestly rather than silently no-op'ing.
 *
 * J.1 — the deploy + graph-persistence routes below. Deploy is admin-only (it creates real agents
 * and writes enforced policy), whereas generating and saving a draft graph is member-level: a
 * draft changes nothing real. Deploy returns UNSIGNED grant handles only — the on-chain
 * `update_associated_keys` signature is taken in the browser via the existing
 * /v1/agents/:id/grant-delegated-key/init|confirm routes. The server signs nothing.
 */
const PromptBodySchema = z.object({ prompt: z.string().min(1) });

/** The raw graph is kept as `unknown` here on purpose — validateGraph/GraphSchema is the authority,
 * and passing it through Zod at the boundary would strip the node positions we intend to store. */
const SaveGraphBodySchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(200).default('Untitled fleet'),
  graph: z.unknown(),
});

const DeployBodySchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(200).default('Untitled fleet'),
  graph: z.unknown(),
});

export function registerGraphBuilderRoutes(app: FastifyInstance): void {
  const { env } = app.deps;

  // Built once per process, not per request — the client is a stateless HTTP wrapper, and the
  // key is static config. Stays null when unconfigured so the handler can 503 honestly.
  const client: GraphModelClient | null = env.GEMINI_API_KEY
    ? (new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) as unknown as GraphModelClient)
    : null;

  app.post('/v1/graph-builder/prompt-to-graph', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    if (!client) {
      return reply.code(503).send({ error: 'gemini_not_configured' });
    }

    const parsed = PromptBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    }

    const result = await promptToGraph(client, {
      prompt: parsed.data.prompt,
      model: env.GEMINI_GRAPH_MODEL,
    });

    if (!result.ok) {
      return reply.code(422).send({ error: 'graph_generation_failed', message: result.error });
    }

    return reply.code(200).send({ graph: result.graph });
  });

  // ── J.1: validate-only. Lets the canvas show "why this won't deploy" without side effects. ──
  app.post('/v1/graph-builder/validate', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = SaveGraphBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = validateGraph(parsed.data.graph);
    return reply.code(200).send({ valid: result.valid, errors: result.errors });
  });

  // ── J: persist a draft canvas (member-level — a draft enforces nothing). ──
  app.post('/v1/graph-builder/graphs', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = SaveGraphBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    try {
      const saved = await saveGraph(pool, {
        id: parsed.data.id ?? `bg_${randomUUID()}`,
        orgId: auth.principal.orgId,
        name: parsed.data.name,
        graph: parsed.data.graph ?? { nodes: [], edges: [] },
      });
      return reply.code(200).send({ graph: saved });
    } catch {
      // saveGraph throws only when the id exists under a DIFFERENT org. 404, not 409 — never
      // confirm the existence of another tenant's resource.
      return reply.code(404).send({ error: 'graph_not_found' });
    }
  });

  app.get('/v1/graph-builder/graphs', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const graphs = await listGraphs(pool, { orgId: auth.principal.orgId });
    return reply.code(200).send({ graphs });
  });

  app.get('/v1/graph-builder/graphs/:id', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id } = request.params as { id: string };
    const graph = await getGraph(pool, { id, orgId: auth.principal.orgId });
    if (!graph) return reply.code(404).send({ error: 'graph_not_found' });
    return reply.code(200).send({ graph });
  });

  /**
   * J.1 — DEPLOY. The only route in the builder with real-world effects, and the only production
   * caller of compileGraphToConfig. Admin-only: it creates agents and writes enforced policy.
   *
   * It does NOT start a workflow — nothing here executes. It creates agents, attaches policy the
   * proxy already enforces, and returns unsigned grant handles for the browser to sign.
   */
  app.post('/v1/graph-builder/deploy', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = DeployBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const orgId = auth.principal.orgId;
    const graphId = parsed.data.id ?? `bg_${randomUUID()}`;

    // Persist BEFORE deploying: if the deploy half-fails, the user's canvas still survives.
    try {
      await saveGraph(pool, { id: graphId, orgId, name: parsed.data.name, graph: parsed.data.graph ?? {} });
    } catch {
      return reply.code(404).send({ error: 'graph_not_found' });
    }

    try {
      const result = await deployGraph(
        { pool, registerAgent, attachTradingFlow, createPolicyVersion, assignPolicy },
        { orgId, graphId, rawGraph: parsed.data.graph, name: parsed.data.name },
      );

      const roleBindings: Record<string, { agentId: string; policyId: string }> = {};
      for (const a of result.agents) roleBindings[a.role] = { agentId: a.agentId, policyId: a.policyId };
      await markGraphDeployed(pool, { id: graphId, orgId, roleBindings });

      // api_key values are returned ONCE here and are deliberately not logged.
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof GraphDeployError) {
        return reply
          .code(err.code === 'invalid_graph' ? 422 : 400)
          .send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      }
      request.log.error({ err, graphId }, 'graph deploy failed');
      return reply.code(500).send({ error: 'deploy_failed' });
    }
  });
}
