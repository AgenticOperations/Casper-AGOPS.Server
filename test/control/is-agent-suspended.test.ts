import { describe, it, expect, vi } from 'vitest';
import { isAgentSuspended } from '../../src/engines/control/kill-switch.js';

function fakePool(rows: Array<{ status: string }>) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as import('pg').Pool;
}

describe('isAgentSuspended', () => {
  it('returns true when the agent row status is suspended', async () => {
    const pool = fakePool([{ status: 'suspended' }]);
    expect(await isAgentSuspended(pool, { agentId: 'agt_1', orgId: 'org_1' })).toBe(true);
  });

  it('returns false when the agent row status is active', async () => {
    const pool = fakePool([{ status: 'active' }]);
    expect(await isAgentSuspended(pool, { agentId: 'agt_1', orgId: 'org_1' })).toBe(false);
  });

  it('returns false (fail-open on lookup, not fail-deny) when no row matches — tenant-fenced / unknown id', async () => {
    const pool = fakePool([]);
    expect(await isAgentSuspended(pool, { agentId: 'agt_nope', orgId: 'org_1' })).toBe(false);
  });

  it('queries by both agent id and org id (tenant fence)', async () => {
    const pool = fakePool([{ status: 'suspended' }]);
    await isAgentSuspended(pool, { agentId: 'agt_1', orgId: 'org_1' });
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['agt_1', 'org_1']);
  });
});
