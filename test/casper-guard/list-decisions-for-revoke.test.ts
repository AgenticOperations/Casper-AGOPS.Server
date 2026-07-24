import { describe, it, expect, vi } from 'vitest';
import { listCasperGuardDecisionsForRevoke } from '../../src/engines/casper-guard/store.js';

function fakePool(rows: Array<{ decision_id: string; status: string }>) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as import('pg').Pool;
}

describe('listCasperGuardDecisionsForRevoke', () => {
  it('splits decisions into reserved (not yet signed) and committed (signed or further)', async () => {
    const pool = fakePool([
      { decision_id: 'cgd_1', status: 'RESERVED' },
      { decision_id: 'cgd_2', status: 'SIGNED' },
      { decision_id: 'cgd_3', status: 'BROADCASTING' },
      { decision_id: 'cgd_4', status: 'RESERVED' },
      { decision_id: 'cgd_5', status: 'SETTLED' },
    ]);

    const result = await listCasperGuardDecisionsForRevoke(pool, { agentId: 'agt_1', orgId: 'org_1' });

    expect(result.reserved.sort()).toEqual(['cgd_1', 'cgd_4']);
    expect(result.committed.sort()).toEqual(['cgd_2', 'cgd_3', 'cgd_5']);
  });

  it('excludes decisions already in a terminal state (DENIED/FAILED_TERMINAL/EXPIRED)', async () => {
    const pool = fakePool([
      { decision_id: 'cgd_1', status: 'DENIED' },
      { decision_id: 'cgd_2', status: 'FAILED_TERMINAL' },
      { decision_id: 'cgd_3', status: 'EXPIRED' },
    ]);

    const result = await listCasperGuardDecisionsForRevoke(pool, { agentId: 'agt_1', orgId: 'org_1' });

    expect(result.reserved).toEqual([]);
    expect(result.committed).toEqual([]);
  });

  it('scopes the query to the given agent and org (tenant fence)', async () => {
    const pool = fakePool([]);
    await listCasperGuardDecisionsForRevoke(pool, { agentId: 'agt_1', orgId: 'org_1' });
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['agt_1', 'org_1']);
  });
});
