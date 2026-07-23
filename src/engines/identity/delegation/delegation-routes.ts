import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authForRoute } from '../access/route-guard.js';
import { attachTradingFlow } from '../../control/attach-trading-flow.js';
import { createPolicyVersion, assignPolicy } from '../../control/store.js';
import { revokeAgentDelegation } from './revoke-agent-delegation.js';
import { suspendAgent } from '../../control/kill-switch.js';
import { revokeDelegatedKey } from './delegated-keys-store.js';
import { revokeAgentInFlight } from '../../casper-guard/policy.js';
import type { CompiledTradingFlow } from '../../control/trading-flow.js';

/**
 * F.1: the two SDK/transport surface pieces not already covered by an existing route —
 * createAgent (POST /v1/agents, agent-routes.ts), authorize (casper-guard authorize-x402/
 * authorize-action), and getDecision (casper-guard decisions/:id/status) already exist. This adds
 * attachTradingFlow (Milestone D wiring) and the full delegated-key revoke (Milestones A+C,
 * distinct from the existing "retire" lifecycle flip in agent-routes.ts).
 */
const AttachFlowBody = z.object({
  flow: z.custom<CompiledTradingFlow>((v) => typeof v === 'object' && v !== null),
  role_assignments: z.record(z.string(), z.string()),
});

export function registerDelegationRoutes(app: FastifyInstance): void {
  app.post('/v1/orgs/:id/trading-flows/attach', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId } = request.params as { id: string };
    const auth = await authForRoute(app, request, 'admin', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = AttachFlowBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    try {
      const result = await attachTradingFlow(
        { pool, createPolicyVersion, assignPolicy },
        { orgId, flow: parsed.data.flow, roleAssignments: parsed.data.role_assignments },
      );
      return reply.code(200).send({ role_assignments: result.roleAssignments });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'attach_failed' });
    }
  });

  app.post('/v1/agents/:id/revoke-delegation', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };

    const result = await revokeAgentDelegation(
      { pool, redis, suspendAgent, revokeDelegatedKey, revokeAgentInFlight },
      { agentId, orgId: auth.principal.orgId },
    );

    return reply.code(200).send({
      agent_id: agentId,
      agent_suspended: result.agentSuspended,
      aborted_decision_ids: result.abortedDecisionIds,
      committed_decision_ids: result.committedDecisionIds,
    });
  });
}
