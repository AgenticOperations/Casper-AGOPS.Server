import type pg from 'pg';

/**
 * Milestone J persistence for the visual builder (migration 0018_builder_graphs).
 *
 * Stores the canvas graph VERBATIM — including node positions, which the Zod `GraphSchema`
 * deliberately does not model and would strip. That is the whole reason this exists rather than
 * rebuilding the canvas with `configToGraph`: the compiled config has no place to put a position,
 * nor any representation of a node the user drew but has not deployed yet.
 *
 * This table is a DESIGN DOCUMENT, never an enforcement surface. Nothing here is consulted on the
 * authorization hot path — caps come from policy_versions/policy_assignments. Every query is
 * fenced on org_id so a graph can never be read or written across tenants.
 */

export interface BuilderGraphRecord {
  id: string;
  orgId: string;
  name: string;
  graph: unknown;
  deployedAt: string | null;
  roleBindings: Record<string, { agentId: string; policyId: string }>;
  updatedAt: string;
}

interface GraphRow {
  id: string;
  org_id: string;
  name: string;
  graph: unknown;
  deployed_at: Date | null;
  role_bindings: Record<string, { agentId: string; policyId: string }>;
  updated_at: Date;
}

function toRecord(row: GraphRow): BuilderGraphRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    graph: row.graph,
    deployedAt: row.deployed_at ? row.deployed_at.toISOString() : null,
    roleBindings: row.role_bindings ?? {},
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Upsert a draft (or re-save an existing) graph. Does not touch deploy state. */
export async function saveGraph(
  pool: pg.Pool,
  params: { id: string; orgId: string; name: string; graph: unknown },
): Promise<BuilderGraphRecord> {
  const res = await pool.query<GraphRow>(
    `INSERT INTO builder_graphs (id, org_id, name, graph)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET graph = EXCLUDED.graph, name = EXCLUDED.name, updated_at = now()
       -- Tenant fence on the UPDATE path too: without this, a caller who guessed another org's
       -- graph id would overwrite it, since ON CONFLICT bypasses any WHERE on the INSERT.
       WHERE builder_graphs.org_id = $2
     RETURNING *`,
    [params.id, params.orgId, params.name, JSON.stringify(params.graph)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('saveGraph: conflicting graph id belongs to another org');
  return toRecord(row);
}

/** Mark a graph deployed and record the role -> {agentId, policyId} bindings Deploy produced. */
export async function markGraphDeployed(
  pool: pg.Pool,
  params: {
    id: string;
    orgId: string;
    roleBindings: Record<string, { agentId: string; policyId: string }>;
  },
): Promise<void> {
  await pool.query(
    `UPDATE builder_graphs
        SET deployed_at = now(), role_bindings = $3, updated_at = now()
      WHERE id = $1 AND org_id = $2`,
    [params.id, params.orgId, JSON.stringify(params.roleBindings)],
  );
}

export async function getGraph(pool: pg.Pool, params: { id: string; orgId: string }): Promise<BuilderGraphRecord | null> {
  const res = await pool.query<GraphRow>('SELECT * FROM builder_graphs WHERE id = $1 AND org_id = $2', [
    params.id,
    params.orgId,
  ]);
  const row = res.rows[0];
  return row ? toRecord(row) : null;
}

export async function listGraphs(pool: pg.Pool, params: { orgId: string }): Promise<BuilderGraphRecord[]> {
  const res = await pool.query<GraphRow>(
    'SELECT * FROM builder_graphs WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 100',
    [params.orgId],
  );
  return res.rows.map(toRecord);
}
