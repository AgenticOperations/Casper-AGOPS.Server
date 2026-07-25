import { describe, it, expect } from 'vitest';
import { resolveAgentFundingPlan } from '../../src/engines/control/agent-funding-plan.js';
import type { AgentFundingDeps } from '../../src/engines/custody/agent-funding.js';

const OPERATOR = '0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267';
const AGENT_OWN = '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a';

const funding = { operatorAccountHash: OPERATOR, wcsprPackageHash: 'pkg' } as unknown as AgentFundingDeps;

const basePolicy = { allowedDestinations: [OPERATOR] } as never;

describe('resolveAgentFundingPlan', () => {
  it('delegated-key agent, fully configured → funds: native destination stays OPERATOR, agentAccountHash = own account, policy union adds own account', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: AGENT_OWN,
      operatorAccountHash: OPERATOR,
      wcsprPackageHash: 'pkg',
      funding,
    });
    // Native rail destination is the operator (fix #1 — no double-send).
    expect(plan.agentFloatAddress).toBe(OPERATOR);
    // Own account passed separately for on-chain funding.
    expect(plan.agentAccountHash).toBe(AGENT_OWN);
    expect(plan.funding).toBe(funding);
    // Fence union adds ONLY the server-derived own account (fix #2).
    expect(plan.effectivePolicy.allowedDestinations).toEqual([OPERATOR, AGENT_OWN]);
  });

  it('no delegated key → no funding, today’s path: destination = policy[0], no agentAccountHash/funding, policy unchanged', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: undefined,
      operatorAccountHash: OPERATOR,
      wcsprPackageHash: 'pkg',
      funding,
    });
    expect(plan.agentFloatAddress).toBe(OPERATOR);
    expect(plan.agentAccountHash).toBeUndefined();
    expect(plan.funding).toBeUndefined();
    expect(plan.effectivePolicy.allowedDestinations).toEqual([OPERATOR]); // unchanged
  });

  it('guard: WCSPR package hash empty → funding skipped, today’s path (additive fence)', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: AGENT_OWN,
      operatorAccountHash: OPERATOR,
      wcsprPackageHash: '',
      funding,
    });
    expect(plan.agentAccountHash).toBeUndefined();
    expect(plan.funding).toBeUndefined();
    expect(plan.effectivePolicy.allowedDestinations).toEqual([OPERATOR]);
  });

  it('guard: operator account empty → funding skipped', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: AGENT_OWN,
      operatorAccountHash: '',
      wcsprPackageHash: 'pkg',
      funding,
    });
    expect(plan.agentAccountHash).toBeUndefined();
    expect(plan.funding).toBeUndefined();
  });

  it('guard: funding deps absent (unit harness) → funding skipped', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: AGENT_OWN,
      operatorAccountHash: OPERATOR,
      wcsprPackageHash: 'pkg',
      funding: undefined,
    });
    expect(plan.agentAccountHash).toBeUndefined();
    expect(plan.funding).toBeUndefined();
  });

  it('fence integrity: an arbitrary non-own destination is NEVER added to allowedDestinations', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: AGENT_OWN,
      operatorAccountHash: OPERATOR,
      wcsprPackageHash: 'pkg',
      funding,
    });
    // Only operator + the server-derived own account — no external address can appear here.
    expect(plan.effectivePolicy.allowedDestinations).not.toContain('00deadbeef');
    expect(plan.effectivePolicy.allowedDestinations).toHaveLength(2);
  });

  it('double-send lock: even with funding on, native destination is the operator, never the agent own account', () => {
    const plan = resolveAgentFundingPlan({
      allocationPolicy: basePolicy,
      agentOwnAccount: AGENT_OWN,
      operatorAccountHash: OPERATOR,
      wcsprPackageHash: 'pkg',
      funding,
    });
    expect(plan.agentFloatAddress).not.toBe(AGENT_OWN);
    expect(plan.agentFloatAddress).toBe(OPERATOR);
  });
});
