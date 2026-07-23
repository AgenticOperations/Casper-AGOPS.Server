import type pg from 'pg';
import { createPolicyVersion, assignPolicy } from './store.js';
import type { CompiledTradingFlow } from './trading-flow.js';

export interface AttachTradingFlowDeps {
  pool: pg.Pool;
  createPolicyVersion: typeof createPolicyVersion;
  assignPolicy: typeof assignPolicy;
}

export interface AttachTradingFlowResult {
  roleAssignments: Record<string, { agentId: string; policyId: string }>;
}

/**
 * F.1: attach a compiled trading flow to real agents. For each role, writes a new spend +
 * allocation policy version (existing append-only policy system) and assigns the spend policy to
 * the given agent (existing policy_assignments, scope='agent'). This is the wiring step between
 * Milestone D's pure compiler and the existing, already-enforced policy system — no new engine.
 */
export async function attachTradingFlow(
  deps: AttachTradingFlowDeps,
  input: {
    orgId: string;
    flow: CompiledTradingFlow;
    roleAssignments: Record<string, string>;
  },
): Promise<AttachTradingFlowResult> {
  const result: AttachTradingFlowResult = { roleAssignments: {} };

  for (const compiledRole of input.flow.roles) {
    const agentId = input.roleAssignments[compiledRole.role];
    if (!agentId) {
      throw new Error(`No agent assigned to role "${compiledRole.role}" in flow "${input.flow.name}"`);
    }

    const spendVersion = await deps.createPolicyVersion(deps.pool, {
      orgId: input.orgId,
      class: 'spend',
      rules: compiledRole.spend,
    });
    await deps.createPolicyVersion(deps.pool, {
      orgId: input.orgId,
      class: 'allocation',
      rules: compiledRole.allocation,
    });

    await deps.assignPolicy(deps.pool, {
      orgId: input.orgId,
      scope: 'agent',
      scopeId: agentId,
      policyId: spendVersion.policyId,
      class: 'spend',
    });

    result.roleAssignments[compiledRole.role] = { agentId, policyId: spendVersion.policyId };
  }

  return result;
}
