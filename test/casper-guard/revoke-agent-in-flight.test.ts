import { describe, it, expect, vi } from 'vitest';
import { revokeAgentInFlight } from '../../src/engines/casper-guard/policy.js';

function fakeDeps(rows: Array<{ decision_id: string; status: string }>) {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT decision_id, status')) {
      return Promise.resolve({ rows });
    }
    if (sql.includes('UPDATE casper_guard_decisions')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('UPDATE casper_guard_holds')) {
      return Promise.resolve({ rows: [{ hold_id: 'cgh_x' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const redis = {
    defineCommand: vi.fn(),
    releaseHold: vi.fn().mockResolvedValue(1),
  };
  return {
    pool: { query } as unknown as import('pg').Pool,
    redis: redis as unknown as import('ioredis').Redis,
  };
}

describe('revokeAgentInFlight (D-2⑤ honest hard-stop)', () => {
  it('aborts every RESERVED decision (not yet signed) and leaves SIGNED/committed ones alone', async () => {
    const deps = fakeDeps([
      { decision_id: 'cgd_1', status: 'RESERVED' },
      { decision_id: 'cgd_2', status: 'SIGNED' },
      { decision_id: 'cgd_3', status: 'RESERVED' },
    ]);

    const result = await revokeAgentInFlight(
      { pool: deps.pool, redis: deps.redis },
      { agentId: 'agt_1', orgId: 'org_1' },
    );

    expect(result.abortedDecisionIds.sort()).toEqual(['cgd_1', 'cgd_3']);
    expect(result.committedDecisionIds).toEqual(['cgd_2']);

    const terminalCalls = (deps.pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE casper_guard_decisions'),
    );
    expect(terminalCalls).toHaveLength(2);
  });

  it('is a no-op (empty result) when the agent has nothing in-flight', async () => {
    const deps = fakeDeps([]);
    const result = await revokeAgentInFlight(
      { pool: deps.pool, redis: deps.redis },
      { agentId: 'agt_1', orgId: 'org_1' },
    );
    expect(result).toEqual({ abortedDecisionIds: [], committedDecisionIds: [] });
  });
});
