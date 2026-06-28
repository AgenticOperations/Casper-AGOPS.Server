import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authForRoute } from '../identity/access/route-guard.js';
import { getTreasuryBalances, listAgentsWithFloats, listTreasuryHistory, secondsSinceLastAllocation } from './treasury-read.js';
import { resolveEffectivePolicy } from '../enforcement/policy-epoch-guard.js';
import { depositFor, type ProvisionDeps } from '../provisioning/deposit.js';
import { createLiveTransferReader, createStubTransferReader } from '../../lib/casper/transfer-reader.js';

/**
 * F2 Treasury — Group A control-plane surface. Dual-credential (session cookie OR sk_ Bearer), fail-closed,
 * tenant-fenced. Reads require member+; control-writes (deposit / float provision / top-up) require admin+.
 * Mirrors control/routes.ts.
 */
export function registerTreasuryRoutes(app: FastifyInstance): void {
  app.get('/v1/treasury/balances', async (request, reply) => {
    const { redis, gateway } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    if (!gateway) return reply.code(503).send({ error: 'gateway_unavailable' });
    const balances = await getTreasuryBalances({ redis, gateway }, auth.principal.orgId);
    return reply.code(200).send(balances);
  });

  app.get('/v1/agents', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const agents = await listAgentsWithFloats(pool, redis, auth.principal.orgId);
    return reply.code(200).send({ agents });
  });

  app.get('/v1/treasury/history', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const events = await listTreasuryHistory(pool, auth.principal.orgId);
    return reply.code(200).send({ events });
  });

  app.post('/v1/treasury/deposit', async (request, reply) => {
    const { redis, gateway } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    if (!gateway) return reply.code(503).send({ error: 'gateway_unavailable' });
    const orgId = auth.principal.orgId;

    const body = request.body as { amount?: unknown };
    if (typeof body?.amount !== 'string' || !/^\d+$/.test(body.amount) || BigInt(body.amount) <= 0n) {
      return reply.code(400).send({ error: 'invalid_amount' });
    }
    await gateway.deposit({ orgId, amount: BigInt(body.amount) });
    const balances = await getTreasuryBalances({ redis, gateway }, orgId);
    return reply.code(200).send({ available: balances.available, deposited: true });
  });

  /** Factory for provision + topup — same logic, different `kind`. Control-write → admin+. */
  function provisionHandler(kind: 'depositFor' | 'topup') {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { pg: pool, redis, gateway, env } = app.deps;
      const auth = await authForRoute(app, request, 'admin');
      if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
      if (!gateway) return reply.code(503).send({ error: 'gateway_unavailable' });
      const orgId = auth.principal.orgId;

      const { id: agentId } = request.params as { id: string };
      // Tenant fence: the agent must belong to the principal's org.
      const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
      if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

      const body = request.body as { amount?: unknown };
      if (typeof body?.amount !== 'string' || !/^\d+$/.test(body.amount) || BigInt(body.amount) <= 0n) {
        return reply.code(400).send({ error: 'invalid_amount' });
      }

      const { policy } = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
      // Server-side destination derivation: own-agent fence, never client-supplied.
      // On Casper the destination is the operator account hash. Fall back to env for orgs seeded
      // before the Casper migration (allowedDestinations may be empty or hold an old EVM address).
      const agentFloatAddress =
        policy.allocation.allowedDestinations[0] ??
        (env.CASPER_OPERATOR_ACCOUNT_HASH !== '' ? env.CASPER_OPERATOR_ACCOUNT_HASH : undefined);
      if (!agentFloatAddress) return reply.code(422).send({ error: 'no_float_destination' });

      const now = Math.floor(Date.now() / 1000);
      const gap = await secondsSinceLastAllocation(pool, agentId, now);
      const deps: ProvisionDeps = { pool, redis, gateway };
      const result = await depositFor(deps, {
        orgId,
        agentId,
        agentFloatAddress,
        amount: BigInt(body.amount),
        policy: policy.allocation,
        kind,
        secondsSinceLastAllocation: gap,
        now,
      });
      if (result.outcome === 'DENY') {
        return reply.code(200).send({ outcome: 'deny', reason: result.reason });
      }
      // result.outcome === 'SUBMITTED'
      return reply.code(200).send({ outcome: 'submitted', allocation_id: result.allocationId, state: 'pending' });
    };
  }

  app.post('/v1/agents/:id/float', provisionHandler('depositFor'));
  app.post('/v1/agents/:id/float/topup', provisionHandler('topup'));
}
