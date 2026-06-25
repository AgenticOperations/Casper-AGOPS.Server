import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setupDemoAgent, resetDemo } from './provision.js';

/**
 * Demo orchestration surface (M9, doc 04 §5, doc 05 §6.5). Env-gated (DEMO_ENABLED) — NEVER registered
 * in production. Self-bootstraps the operator org from the presented sk_ so a fresh `npm start` can run
 * the killer cell. Composes the SAME store fns + the SAME real Oracle as production; it provisions the
 * scenario, it does NOT fake any decision (decisions still come from the real enforce spine).
 *
 * Auth note: POST /v1/demo/setup intentionally does NOT call `authenticateAdmin` (which would 401 an
 * unseen sk_ before bootstrap). It validates the Bearer shape only and hands the raw sk_ to
 * `setupDemoAgent`, which resolves-or-bootstraps the org. Safe because the whole surface is env-gated.
 */

const setupSchema = z.object({ cap_cspr: z.number().int().positive().max(1000).default(10) });
const resetSchema = z.object({ org_id: z.string().min(1) });

export function registerDemoRoutes(app: FastifyInstance): void {
  const env = app.deps.env;

  app.post('/v1/demo/setup', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const sk = auth.slice('Bearer '.length);
    const parsed = setupSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const handle = await setupDemoAgent(pool, redis, {
      adminKey: sk,
      capCspr: parsed.data.cap_cspr,
      payTo: env.DEMO_CSPR_PAY_TO,
      vendorHost: env.DEMO_VENDOR_HOST,
      resource: env.DEMO_RESOURCE,
      ...(env.DEMO_CSPR_TOKEN_PACKAGE_HASH !== '' ? { tokenPackageHash: env.DEMO_CSPR_TOKEN_PACKAGE_HASH } : {}),
      tokenName: env.DEMO_CSPR_TOKEN_NAME,
      tokenVersion: env.DEMO_CSPR_TOKEN_VERSION,
    });
    return reply.code(200).send(handle);
  });

  app.post('/v1/demo/reset', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = resetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    await resetDemo(pool, redis, { orgId: parsed.data.org_id });
    return reply.code(200).send({ reset: true });
  });
}
