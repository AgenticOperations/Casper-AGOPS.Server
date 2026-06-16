import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authForRoute } from '../identity/access/route-guard.js';
import { resolveEffectivePolicy } from '../enforcement/policy-epoch-guard.js';
import type { EffectivePolicy, SpendRailPermission } from '../../contracts/index.js';
import { createPolicyVersion, assignPolicy } from './store.js';
import { recompileAgentPolicy } from './publish.js';
import { bumpOrgEpoch } from './epoch.js';
import { getReputation } from '../identity/reputation.js';

/**
 * Serialize an EffectivePolicy (engine bigint money) to the wire shape:
 * snake_case keys, all bigint money fields as base-unit strings, epoch as number.
 * Used by GET /v1/agents/:id/policy to keep money off the float path on the wire.
 */
function serializeEffectivePolicy(p: EffectivePolicy) {
  return {
    agent_id: p.agentId,
    org_id: p.orgId,
    policy_id: p.policyId,
    policy_epoch: p.policyEpoch,
    spend: {
      spend_cap: p.spend.spendCap.toString(),
      per_transaction_max: p.spend.perTransactionMax.toString(),
      service_scope: p.spend.serviceScope,
      rail_permission: p.spend.railPermission,
      velocity_limit_per_hour: p.spend.velocityLimitPerHour,
    },
    allocation: {
      total_budget: p.allocation.totalBudget.toString(),
      per_agent_max: p.allocation.perAgentMax.toString(),
      cooldown_seconds: p.allocation.cooldownSeconds,
      allowed_destinations: p.allocation.allowedDestinations,
    },
  };
}

/** Zod schema for the A2 dial body — base-unit decimal strings only, no floats. */
const DialBodySchema = z.object({
  class: z.literal('spend'),
  rules: z.object({
    spend_cap: z.string().regex(/^\d+$/),
    per_transaction_max: z.string().regex(/^\d+$/),
    service_scope: z.array(z.string()),
    rail_permission: z.array(
      z.enum(['raw-x402', 'circle-nano', 'casper-x402', 'cspr-trade', 'casper-deploy']),
    ),
    velocity_limit_per_hour: z.number().int().nonnegative(),
  }),
});

export function registerPolicyRoutes(app: FastifyInstance): void {
  app.get('/v1/agents/:id/policy', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    // Read surface → member+ (cookie OR sk_).
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const orgId = auth.principal.orgId;

    const { id: agentId } = request.params as { id: string };

    // Tenant fence: the agent must belong to the principal's org (mirrors treasury-routes.ts).
    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    const { policy } = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
    return reply.code(200).send(serializeEffectivePolicy(policy));
  });

  /**
   * A2 — POST /v1/agents/:id/policy  (the dial — fail-closed spend-policy write).
   *
   * Creates an immutable new policy version at agent scope, bumps the org epoch, and
   * recompiles the agent's effective policy. The most-restrictive intersection means an
   * agent-scope cap that is tighter than the org-scope cap wins (min).
   */
  app.post('/v1/agents/:id/policy', async (request, reply) => {
    const { pg: pool, redis } = app.deps;

    // 1. Authenticate + authorize (control-write → admin+; cookie OR sk_; fail-closed).
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const orgId = auth.principal.orgId;

    // 2. Parse agent id from path.
    const { id: agentId } = request.params as { id: string };

    // 3. Tenant fence: the agent must belong to this principal's org.
    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    // 4. Zod-validate body (400 on malformed — no partial write).
    const parsed = DialBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    }
    const { rules } = parsed.data;

    // 5. Build SpendPolicy (wire decimal strings → bigint money).
    const spendPolicy = {
      spendCap: BigInt(rules.spend_cap),
      perTransactionMax: BigInt(rules.per_transaction_max),
      serviceScope: rules.service_scope,
      railPermission: rules.rail_permission as SpendRailPermission[],
      velocityLimitPerHour: rules.velocity_limit_per_hour,
    };

    // 6. Look up whether this agent already has an agent-scope spend assignment.
    //    If yes, create a new version of the SAME policy (create-or-version pattern).
    //    If no, create a brand-new policy and assign it at agent scope.
    const existingAssignment = await pool.query<{ policy_id: string }>(
      `SELECT policy_id FROM policy_assignments
        WHERE scope = 'agent' AND scope_id = $1 AND class = 'spend'
        ORDER BY id DESC LIMIT 1`,
      [agentId],
    );
    const existingPolicyId: string | undefined = existingAssignment.rows[0]?.policy_id;

    const { policyId, version, policyEpoch } = await createPolicyVersion(pool, {
      ...(existingPolicyId !== undefined ? { policyId: existingPolicyId } : {}),
      orgId,
      class: 'spend',
      rules: spendPolicy,
    });

    // 7. Only assign when there was no existing agent-scope assignment.
    //    Re-dials add a new version to the existing policy; no new assignment row needed.
    if (!existingPolicyId) {
      await assignPolicy(pool, {
        orgId,
        scope: 'agent',
        scopeId: agentId,
        policyId,
        class: 'spend',
      });
    }

    // 8. Recompile and publish the agent's effective policy to Redis.
    await recompileAgentPolicy(pool, redis, agentId);

    // 9. Mirror the PG epoch to the Redis monotonic counter (staleness guard, NFR-03).
    await bumpOrgEpoch(redis, orgId, policyEpoch);

    return reply.code(200).send({ policy_id: policyId, version, policy_epoch: policyEpoch });
  });

  /**
   * A3 — GET /v1/agents/:id/reputation  (read-only, admin-auth).
   *
   * Wraps the identity engine's reputation read. This route NEVER gates or alters anything:
   * reputation is read-side only and NEVER an input to a payment decision
   * (engine-specs-FINAL.md:237-243 — decouple invariant). `UNRATED` is a trust default,
   * not a payment deny. No branching on the reputation result — pure map-and-send.
   *
   * Wire shape:
   *   Unrated: { rated: false, status: 'UNRATED' }
   *   Rated:   { rated: true, score: number, unique_counterparties: number, capital_at_risk: string }
   */
  app.get('/v1/agents/:id/reputation', async (request, reply) => {
    const { pg: pool } = app.deps;

    // 1. Authenticate (read surface → member+; cookie OR sk_; fail-closed).
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const orgId = auth.principal.orgId;

    // 2. Parse agent id from path.
    const { id: agentId } = request.params as { id: string };

    // 3. Tenant fence: the agent must belong to this principal's org.
    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    // 4. Compute reputation (read-only, never blocks a payment).
    const reputation = await getReputation({ pool }, { agentId, now: Date.now() });

    // 5. Map to wire shape: camelCase → snake_case, bigint → string. No gating on the result.
    if (!reputation.rated) {
      return reply.code(200).send({ rated: false, status: 'UNRATED' });
    }
    return reply.code(200).send({
      rated: true,
      score: reputation.score,
      unique_counterparties: reputation.uniqueCounterparties,
      capital_at_risk: reputation.capitalAtRisk.toString(),
    });
  });
}
