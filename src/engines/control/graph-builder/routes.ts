import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { authForRoute } from '../../identity/access/route-guard.js';
import { promptToGraph, type GraphModelClient } from './prompt-to-graph.js';

/**
 * H.1 — server-side endpoint wrapping promptToGraph(prompt). Auth follows the existing
 * member+ pattern (sk_ machine key or cookie). No signer/deploy/vault dependency is wired in
 * here or in promptToGraph.ts — see prompt-to-graph-safety.test.ts. If GEMINI_API_KEY is
 * unset, the endpoint 503s honestly rather than silently no-op'ing.
 */
const PromptBodySchema = z.object({ prompt: z.string().min(1) });

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
}
