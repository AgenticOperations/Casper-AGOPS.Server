import { describe, it, expect } from 'vitest';
import {
  compileAllocation,
  compileEffectivePolicy,
  compileSpend,
} from '../../src/engines/control/policy-compile.js';
import type { AllocationPolicy, SpendPolicy } from '../../src/contracts/index.js';

/**
 * Thesis claim: effective policy = most-restrictive intersection root→leaf; a child can
 * only narrow a parent, never widen it (policy-engine-FINAL.md:59-67, governing rule :60).
 */

const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;

describe('effective policy = most-restrictive intersection (root → leaf)', () => {
  it('spend: min caps, intersected allowlists, min velocity; a child cannot widen', () => {
    const org: SpendPolicy = {
      spendCap: usdc(100),
      perTransactionMax: usdc(50),
      serviceScope: ['svc:a', 'svc:b', 'svc:c'],
      railPermission: ['raw-x402', 'circle-nano'],
      velocityLimitPerHour: 100,
    };
    const agent: SpendPolicy = {
      spendCap: usdc(10),
      perTransactionMax: usdc(80), // tries to widen perTx — must NOT win
      serviceScope: ['svc:b', 'svc:c', 'svc:z'],
      railPermission: ['circle-nano'],
      velocityLimitPerHour: 20,
    };

    const eff = compileSpend([org, agent]);
    expect(eff.spendCap).toBe(usdc(10)); // min
    expect(eff.perTransactionMax).toBe(usdc(50)); // child cannot widen → parent's 50
    expect(eff.serviceScope).toEqual(['svc:b', 'svc:c']); // intersection, parent order
    expect(eff.railPermission).toEqual(['circle-nano']); // intersection
    expect(eff.velocityLimitPerHour).toBe(20); // min
  });

  it('allocation: min budgets, max cooldown, intersected destinations', () => {
    const org: AllocationPolicy = {
      totalBudget: usdc(200),
      perAgentMax: usdc(10),
      cooldownSeconds: 30,
      allowedDestinations: ['0xA', '0xB'],
    };
    const team: AllocationPolicy = {
      totalBudget: usdc(500), // tries to widen budget — must NOT win
      perAgentMax: usdc(5),
      cooldownSeconds: 60,
      allowedDestinations: ['0xB', '0xC'],
    };

    const eff = compileAllocation([org, team]);
    expect(eff.totalBudget).toBe(usdc(200)); // min (child cannot widen)
    expect(eff.perAgentMax).toBe(usdc(5)); // min
    expect(eff.cooldownSeconds).toBe(60); // max (longer cooldown is more restrictive)
    expect(eff.allowedDestinations).toEqual(['0xB']); // intersection
  });

  it('assembles a full EffectivePolicy carrying ids + epoch', () => {
    const spend: SpendPolicy = {
      spendCap: usdc(10),
      perTransactionMax: usdc(10),
      serviceScope: ['svc:a'],
      railPermission: ['raw-x402'],
      velocityLimitPerHour: 10,
    };
    const allocation: AllocationPolicy = {
      totalBudget: usdc(200),
      perAgentMax: usdc(10),
      cooldownSeconds: 0,
      allowedDestinations: ['0xA'],
    };

    const eff = compileEffectivePolicy({
      agentId: 'agt_1',
      orgId: 'org_1',
      policyId: 'policy_1@v1',
      policyEpoch: 7,
      spendLayers: [spend],
      allocationLayers: [allocation],
    });
    expect(eff.policyEpoch).toBe(7);
    expect(eff.agentId).toBe('agt_1');
    expect(eff.spend.spendCap).toBe(usdc(10));
    expect(eff.allocation.totalBudget).toBe(usdc(200));
  });
});
