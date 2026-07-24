import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { authForRoute } from '../../identity/access/route-guard.js';
import { promptToGraph } from './prompt-to-graph.js';

/**
 * H.1 — server-side endpoint wrapping promptToGraph(prompt). Auth follows the existing
 * member+ pattern (sk_ machine key or cookie). No signer/deploy/vault dependency is wired in
 * here or in promptToGraph.ts — see prompt-to-graph-safety.test.ts. If ANTHROPIC_API_KEY is
 * unset, the endpoint 503s honestly rather than silently no-op'ing.
 */
const PromptBodySchema = z.object({ prompt: z.string().min(1) });

export function registerGraphBuilderRoutes(app: FastifyInstance): void {
  app.post('/v1/graph-builder/prompt-to-graph', async (request, reply) => {
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const { env } = app.deps;
    if (!env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'anthropic_not_configured' });
    }

    const parsed = PromptBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const result = await promptToGraph(client, { prompt: parsed.data.prompt });

    if (!result.ok) {
      return reply.code(422).send({ error: 'graph_generation_failed', message: result.error });
    }

    return reply.code(200).send({ graph: result.graph });
  });
}
