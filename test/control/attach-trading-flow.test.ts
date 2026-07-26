import { describe, it, expect, vi } from 'vitest';
import { attachTradingFlow } from '../../src/engines/control/attach-trading-flow.js';
import type { CompiledTradingFlow } from '../../src/engines/control/trading-flow.js';

function fakeDeps() {
  const createPolicyVersion = vi
    .fn()
    .mockImplementation(async (_pool: unknown, params: { class: string }) => ({
      policyId: `pol_${params.class}_x`,
      version: 1,
      policyEpoch: 5,
    }));
  const assignPolicy = vi.fn().mockResolvedValue('assign_1');
  return { createPolicyVersion, assignPolicy };
}

const compiledFlow: CompiledTradingFlow = {
  name: 'test-flow',
  version: 1,
  roles: [
    {
      role: 'trader',
      allowedActions: ['cspr-trade'],
      spend: {
        spendCap: 2000n,
        perTransactionMax: 2000n,
        serviceScope: ['cspr.trade:swap'],
        railPermission: ['cspr-trade'],
        velocityLimitPerHour: 5,
      },
      allocation: {
        totalBudget: 10000n,
        perAgentMax: 2000n,
        cooldownSeconds: 60,
        allowedDestinations: ['*'],
      },
    },
  ],
};

describe('attachTradingFlow (F.1 — attach a compiled flow to real agents)', () => {
  it('creates a spend + allocation policy version per role and assigns them to the given agent', async () => {
    const deps = fakeDeps();
    const pool = {} as unknown as import('pg').Pool;

    const result = await attachTradingFlow(
      { pool, createPolicyVersion: deps.createPolicyVersion, assignPolicy: deps.assignPolicy },
      { orgId: 'org_1', flow: compiledFlow, roleAssignments: { trader: 'agt_1' } },
    );

    expect(deps.createPolicyVersion).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ orgId: 'org_1', class: 'spend', rules: compiledFlow.roles[0]!.spend }),
    );
    expect(deps.createPolicyVersion).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ orgId: 'org_1', class: 'allocation', rules: compiledFlow.roles[0]!.allocation }),
    );
    expect(deps.assignPolicy).toHaveBeenCalledWith(pool, {
      orgId: 'org_1',
      scope: 'agent',
      scopeId: 'agt_1',
      policyId: 'pol_spend_x',
      class: 'spend',
    });
    expect(result.roleAssignments).toEqual({ trader: { agentId: 'agt_1', policyId: 'pol_spend_x' } });
  });

  it('throws if a role in the flow has no agent assignment given', async () => {
    const deps = fakeDeps();
    const pool = {} as unknown as import('pg').Pool;

    await expect(
      attachTradingFlow(
        { pool, createPolicyVersion: deps.createPolicyVersion, assignPolicy: deps.assignPolicy },
        { orgId: 'org_1', flow: compiledFlow, roleAssignments: {} },
      ),
    ).rejects.toThrow(/no agent assigned to role "trader"/i);
  });
});
