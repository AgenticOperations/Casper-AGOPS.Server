import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Quote } from '../../contracts/index.js';
import { newPaymentId } from '../../lib/ids.js';
import { parse402 } from '../resolution/parse-402.js';
import { ResolutionError, type Raw402Body } from '../resolution/types.js';
import { enforceSpend } from '../enforcement/enforce.js';
import { emitDecisionSafe } from '../monitoring/telemetry.js';
import { authenticateAgent } from './auth.js';

/**
 * E9 Oracle — `POST /v1/payment/authorize`, the single agent-egress entrypoint (engine-specs-FINAL.md
 * §E9, the 11-step flow). The agent presents its `ag_live_` bearer and the verbatim 402 it received;
 * agentOps authenticates, asserts the bearer owns the named agent (no acting-as), resolves the 402 to
 * a typed quote, and runs the enforcement spine. agentOps SIGNS ONLY — the signed X-PAYMENT is handed
 * back for the agent to submit (BROADCASTING boundary, BUG-41).
 *
 * Outcome → HTTP: ALLOW → 200 {payment_id, x_payment}; DENY → 403 {error: reason}; DUPLICATE → 409;
 * auth failure → 401/403; a malformed 402 → 422 (fail-closed); a malformed envelope → 400.
 */

const accept402Schema = z
  .object({
    scheme: z.string(),
    network: z.string().optional(),
    maxAmountRequired: z.string(),
    resource: z.string().optional(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().optional(),
    asset: z.string().optional(),
    extra: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
        verifyingContract: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const authorizeBodySchema = z.object({
  agent_id: z.string().min(1),
  raw_402_body: z.object({
    x402Version: z.number().optional(),
    accepts: z.array(accept402Schema).min(1),
    error: z.string().optional(),
  }),
  request_context: z.object({
    method: z.string().min(1),
    url: z.string().min(1),
  }),
});

export function registerAuthorizeRoute(app: FastifyInstance): void {
  app.post('/v1/payment/authorize', async (request, reply) => {
    const { pg: pool, redis, hotPath } = app.deps;
    // The hot path requires the signer + on-chain read seams; an unconfigured deployment serves
    // health checks but cannot authorize (wired in L8).
    if (!hotPath) {
      return reply.code(503).send({ error: 'oracle_not_configured' });
    }

    // 1. AuthN — resolve the ag_live_ bearer to a tenant-bound agent; sk_ is fenced out pre-lookup.
    const auth = await authenticateAgent(pool, request.headers.authorization);
    if (!auth.ok) {
      return reply.code(auth.code).send({ error: auth.reason });
    }

    // 2. Validate the request envelope (the 402 contents are validated by parse402, fail-closed).
    const parsed = authorizeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const body = parsed.data;

    // 3. Tenant assertion — the bearer's agent must be the named agent (no acting-as, cross-tenant).
    if (body.agent_id !== auth.agent.agentId) {
      return reply.code(403).send({ error: 'tenant_mismatch' });
    }

    // 4. Resolve the 402 into one concrete, signable quote (fail-closed → 422).
    const now = Math.floor(Date.now() / 1000);
    let quote: Quote;
    try {
      quote = parse402(body.raw_402_body as Raw402Body, body.request_context, now);
    } catch (err) {
      if (err instanceof ResolutionError) {
        return reply.code(422).send({ error: err.code });
      }
      throw err;
    }

    // 5. Mint the FSM key + resolve the agent-float from-address (Phase-1 single float; M6 = per-agent).
    const paymentId = newPaymentId();
    const fromAddress = await hotPath.signer.addressFor('agent-float');

    // 6. Enforcement spine (policy → grant claim → reserve → sign → X-PAYMENT, state BROADCASTING).
    const result = await enforceSpend(
      {
        pool,
        redis,
        signer: hotPath.signer,
        tokenDomainSource: hotPath.tokenDomainSource,
        domainRegistry: hotPath.domainRegistry,
        chainId: hotPath.chainId,
        ...(hotPath.knownTokens ? { knownTokens: hotPath.knownTokens } : {}),
      },
      { agentId: auth.agent.agentId, orgId: auth.agent.orgId, quote, fromAddress, paymentId, now },
    );

    // 7. Emit a fail-open C-10 telemetry COPY (redacted), then map the outcome to HTTP. C-10 is an
    //    ASYNC copy (engine-specs-FINAL.md:60); the emit is FIRE-AND-FORGET (never awaited) so neither the
    //    telemetry write's latency NOR its failure can ever touch a committed payment's response path —
    //    Monitoring must never be wired such that it can block spend (:264). emitDecisionSafe never rejects
    //    (it swallows internally), so the un-awaited promise raises no unhandled rejection. The copy is
    //    rebuildable from the P4 audit row, so a dropped emit costs visibility only. The X-PAYMENT is
    //    logged under a redacted path (never raw sig bytes).
    const base = {
      agentId: auth.agent.agentId,
      orgId: auth.agent.orgId,
      railScheme: quote.rail.scheme,
      railChain: quote.rail.chain,
      resourceId: quote.resourceId,
      amount: quote.amount.toString(),
      ts: now,
    };
    switch (result.outcome) {
      case 'ALLOW':
        void emitDecisionSafe(redis, { ...base, paymentId: result.paymentId, outcome: 'ALLOW' });
        request.log.info(
          { decision: { payment_id: result.paymentId, outcome: 'ALLOW', x_payment: result.xPayment } },
          'authorize.decision',
        );
        return reply.code(200).send({ payment_id: result.paymentId, x_payment: result.xPayment });
      case 'DENY':
        void emitDecisionSafe(redis, { ...base, paymentId, outcome: 'DENY', reason: result.reason });
        request.log.info(
          { decision: { payment_id: paymentId, outcome: 'DENY', reason: result.reason } },
          'authorize.decision',
        );
        return reply.code(403).send({ error: result.reason });
      case 'DUPLICATE':
        void emitDecisionSafe(redis, { ...base, paymentId: result.paymentId, outcome: 'DUPLICATE' });
        return reply.code(409).send({ payment_id: result.paymentId, error: 'duplicate' });
    }
  });
}
