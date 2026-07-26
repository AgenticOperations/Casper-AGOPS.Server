import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { saveGraph, markGraphDeployed, getGraph, listGraphs } from '../../../src/engines/control/graph-builder/graph-store.js';

/**
 * Milestone J persistence. These assert the TENANT FENCE and the position-preserving round trip
 * at the query level, without a live Postgres: every query must carry org_id, because a graph id
 * is guessable and an unfenced UPDATE would let one org overwrite another's canvas.
 */

function fakePool(rows: unknown[] = []) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as pg.Pool, query };
}

const row = {
  id: 'bg_1',
  org_id: 'org_a',
  name: 'solo',
  graph: { nodes: [{ id: 'a', type: 'Agent', config: {}, position: { x: 12, y: 34 } }], edges: [] },
  deployed_at: null,
  role_bindings: {},
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('J graph-store tenant fencing', () => {
  it('saveGraph fences the ON CONFLICT update on org_id', async () => {
    const { pool, query } = fakePool([row]);
    await saveGraph(pool, { id: 'bg_1', orgId: 'org_a', name: 'solo', graph: { nodes: [], edges: [] } });
    const sql = query.mock.calls[0]![0] as unknown as string;
    // Without this WHERE, ON CONFLICT DO UPDATE would happily overwrite another org's row.
    expect(sql).toMatch(/WHERE builder_graphs\.org_id = \$2/);
  });

  it('saveGraph throws rather than silently no-op when the id belongs to another org', async () => {
    const { pool } = fakePool([]); // conflict + org mismatch => zero rows returned
    await expect(
      saveGraph(pool, { id: 'bg_1', orgId: 'org_b', name: 'x', graph: {} }),
    ).rejects.toThrow(/another org/);
  });

  it('getGraph filters by org_id, not just id', async () => {
    const { pool, query } = fakePool([row]);
    await getGraph(pool, { id: 'bg_1', orgId: 'org_a' });
    expect(query.mock.calls[0]![0]).toMatch(/WHERE id = \$1 AND org_id = \$2/);
  });

  it('markGraphDeployed filters by org_id', async () => {
    const { pool, query } = fakePool([]);
    await markGraphDeployed(pool, { id: 'bg_1', orgId: 'org_a', roleBindings: {} });
    expect(query.mock.calls[0]![0]).toMatch(/WHERE id = \$1 AND org_id = \$2/);
  });

  it('listGraphs scopes to the org', async () => {
    const { pool, query } = fakePool([row]);
    await listGraphs(pool, { orgId: 'org_a' });
    expect(query.mock.calls[0]![0]).toMatch(/WHERE org_id = \$1/);
  });
});

describe('J graph-store round trip', () => {
  it('preserves node positions verbatim (the reason this table exists)', async () => {
    const { pool } = fakePool([row]);
    const saved = await getGraph(pool, { id: 'bg_1', orgId: 'org_a' });
    const nodes = (saved?.graph as { nodes: Array<{ position: { x: number; y: number } }> }).nodes;
    expect(nodes[0]?.position).toEqual({ x: 12, y: 34 });
  });

  it('reports a never-deployed draft as deployedAt null', async () => {
    const { pool } = fakePool([row]);
    const saved = await getGraph(pool, { id: 'bg_1', orgId: 'org_a' });
    expect(saved?.deployedAt).toBeNull();
  });
});
