import { describe, it, expect, vi } from 'vitest';
import { revokeAgentDelegation } from '../../../src/engines/identity/delegation/revoke-agent-delegation.js';

describe('revokeAgentDelegation (F.1 — full revoke: instant kill-switch + on-chain-key revoke + in-flight handling)', () => {
  const pool = {} as unknown as import('pg').Pool;
  const redis = {} as unknown as import('ioredis').Redis;

  it('sets the instant kill-switch, revokes the delegated key, and aborts in-flight decisions — in that order', async () => {
    const calls: string[] = [];
    const deps = {
      pool,
      redis,
      suspendAgent: vi.fn().mockImplementation(async () => {
        calls.push('suspendAgent');
        return true;
      }),
      revokeDelegatedKey: vi.fn().mockImplementation(async () => {
        calls.push('revokeDelegatedKey');
      }),
      revokeAgentInFlight: vi.fn().mockImplementation(async () => {
        calls.push('revokeAgentInFlight');
        return { abortedDecisionIds: ['cgd_1'], committedDecisionIds: ['cgd_2'] };
      }),
    };

    const result = await revokeAgentDelegation(deps, { agentId: 'agt_1', orgId: 'org_1' });

    // The kill-switch (instant, no on-chain wait) must land before the revoke deploy is even
    // considered, per D-2④ — an agent must be unable to authorize the instant this call starts.
    expect(calls[0]).toBe('suspendAgent');
    expect(calls).toContain('revokeDelegatedKey');
    expect(calls).toContain('revokeAgentInFlight');
    expect(result).toEqual({
      agentSuspended: true,
      abortedDecisionIds: ['cgd_1'],
      committedDecisionIds: ['cgd_2'],
    });
  });

  it('still revokes the delegated key and aborts in-flight decisions even if the agent was already suspended', async () => {
    const deps = {
      pool,
      redis,
      suspendAgent: vi.fn().mockResolvedValue(true), // idempotent per kill-switch.ts contract
      revokeDelegatedKey: vi.fn().mockResolvedValue(undefined),
      revokeAgentInFlight: vi.fn().mockResolvedValue({ abortedDecisionIds: [], committedDecisionIds: [] }),
    };

    const result = await revokeAgentDelegation(deps, { agentId: 'agt_1', orgId: 'org_1' });
    expect(deps.revokeDelegatedKey).toHaveBeenCalledWith(pool, { agentId: 'agt_1' });
    expect(deps.revokeAgentInFlight).toHaveBeenCalledWith({ pool, redis }, { agentId: 'agt_1', orgId: 'org_1' });
    expect(result.agentSuspended).toBe(true);
  });
});
