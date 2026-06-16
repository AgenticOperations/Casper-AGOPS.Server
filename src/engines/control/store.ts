import type pg from 'pg';
import type { AllocationPolicy, SpendPolicy } from '../../contracts/index.js';
import {
  issueAgentApiKey,
  newAgentId,
  newAssignmentId,
  newOrgId,
  newPolicyId,
  newTeamId,
  type IssuedKey,
} from '../../lib/ids.js';
import {
  decodeAllocation,
  decodeSpend,
  encodeAllocation,
  encodeSpend,
  type AllocationPolicyJson,
  type SpendPolicyJson,
} from './codec.js';
import type { AgentRecord, OrgRecord, PolicyClass, PolicyVersionRecord, TeamRecord } from './types.js';

/**
 * Control-engine system of record (Postgres). Policy versions are append-only: there is
 * deliberately NO update path — an "edit" is {@link createPolicyVersion} writing a new
 * `(policy_id, version)`. Every version write bumps the org's monotonic `policy_epoch`.
 */

export async function createOrg(
  pool: pg.Pool,
  params: { name: string; adminKeyHash: string },
): Promise<OrgRecord> {
  const id = newOrgId();
  await pool.query('INSERT INTO orgs (id, name, admin_key_hash) VALUES ($1, $2, $3)', [
    id,
    params.name,
    params.adminKeyHash,
  ]);
  return { id, name: params.name, adminKeyHash: params.adminKeyHash, policyEpoch: 0 };
}

export async function createTeam(
  pool: pg.Pool,
  params: { orgId: string; name: string; parentTeamId?: string | null },
): Promise<TeamRecord> {
  const id = newTeamId();
  const parentTeamId = params.parentTeamId ?? null;
  await pool.query('INSERT INTO teams (id, org_id, parent_team_id, name) VALUES ($1, $2, $3, $4)', [
    id,
    params.orgId,
    parentTeamId,
    params.name,
  ]);
  return { id, orgId: params.orgId, parentTeamId, name: params.name };
}

export async function registerAgent(
  pool: pg.Pool,
  params: { orgId: string; teamId?: string | null; name?: string },
): Promise<{ agent: AgentRecord; apiKey: IssuedKey }> {
  const id = newAgentId();
  const teamId = params.teamId ?? null;
  const name = params.name ?? '';
  const apiKey = issueAgentApiKey();
  await pool.query(
    'INSERT INTO agents (id, org_id, team_id, api_key_hash, name) VALUES ($1, $2, $3, $4, $5)',
    [id, params.orgId, teamId, apiKey.hash, name],
  );
  return {
    agent: {
      id,
      orgId: params.orgId,
      teamId,
      name,
      apiKeyHash: apiKey.hash,
      passportId: null,
      status: 'active',
    },
    apiKey,
  };
}

/** Rename an agent, tenant-fenced. Returns true if a row in this org was updated. */
export async function renameAgent(
  pool: pg.Pool,
  orgId: string,
  agentId: string,
  name: string,
): Promise<boolean> {
  const res = await pool.query('UPDATE agents SET name = $3 WHERE id = $1 AND org_id = $2', [
    agentId,
    orgId,
    name,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Retire an agent (terminal). Tenant-fenced + idempotency-fenced (no-op if already retired). Returns
 * true only when a non-retired row in this org flips to 'retired'. The hot-path guard
 * (oracle/auth.ts) rejects any non-active status, so a retired agent's ag_ stops authorizing at once.
 */
export async function retireAgent(pool: pg.Pool, orgId: string, agentId: string): Promise<boolean> {
  const res = await pool.query(
    "UPDATE agents SET status = 'retired' WHERE id = $1 AND org_id = $2 AND status <> 'retired'",
    [agentId, orgId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Rotate an agent's ag_ key: mint a new one, REPLACE the stored hash, and return the new token ONCE.
 * Tenant-fenced. Because the hot path looks the agent up by `api_key_hash`, replacing the hash makes
 * the OLD token resolve to no agent immediately (it stops authorizing). Returns null cross-tenant.
 */
export async function rotateAgentKey(
  pool: pg.Pool,
  orgId: string,
  agentId: string,
): Promise<IssuedKey | null> {
  const apiKey = issueAgentApiKey();
  const res = await pool.query(
    'UPDATE agents SET api_key_hash = $3 WHERE id = $1 AND org_id = $2 RETURNING id',
    [agentId, orgId, apiKey.hash],
  );
  return (res.rowCount ?? 0) > 0 ? apiKey : null;
}

export type CreatePolicyVersionParams =
  | { policyId?: string; orgId: string; class: 'spend'; rules: SpendPolicy }
  | { policyId?: string; orgId: string; class: 'allocation'; rules: AllocationPolicy };

/**
 * Insert a new immutable policy version and bump the org epoch, atomically. If `policyId`
 * is supplied this is an edit (next version of that policy); otherwise a brand-new policy.
 */
export async function createPolicyVersion(
  pool: pg.Pool,
  params: CreatePolicyVersionParams,
): Promise<{ policyId: string; version: number; policyEpoch: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent policy writes for this org by locking the org row we also bump.
    // MAX(version)+1 is then computed without a race; the (policy_id, version) PK still
    // backstops integrity. A missing org surfaces at the FK on INSERT (fail-closed).
    await client.query('SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE', [params.orgId]);
    const policyId = params.policyId ?? newPolicyId();
    const verRes = await client.query<{ next: string }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM policies WHERE policy_id = $1',
      [policyId],
    );
    const version = Number(verRes.rows[0]?.next ?? 1);
    const rulesJson =
      params.class === 'spend' ? encodeSpend(params.rules) : encodeAllocation(params.rules);
    await client.query(
      'INSERT INTO policies (policy_id, version, org_id, class, rules) VALUES ($1, $2, $3, $4, $5)',
      [policyId, version, params.orgId, params.class, JSON.stringify(rulesJson)],
    );
    const epochRes = await client.query<{ policy_epoch: number }>(
      'UPDATE orgs SET policy_epoch = policy_epoch + 1 WHERE id = $1 RETURNING policy_epoch',
      [params.orgId],
    );
    await client.query('COMMIT');
    return { policyId, version, policyEpoch: Number(epochRes.rows[0]?.policy_epoch ?? 0) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface PolicyRow {
  policy_id: string;
  version: number;
  org_id: string;
  class: PolicyClass;
  rules: SpendPolicyJson | AllocationPolicyJson;
  created_at: Date;
}

function toPolicyRecord(row: PolicyRow): PolicyVersionRecord {
  const base = {
    policyId: row.policy_id,
    version: row.version,
    orgId: row.org_id,
    createdAt: row.created_at.toISOString(),
  };
  if (row.class === 'spend') {
    return { ...base, class: 'spend', rules: decodeSpend(row.rules as SpendPolicyJson) };
  }
  return { ...base, class: 'allocation', rules: decodeAllocation(row.rules as AllocationPolicyJson) };
}

export async function getPolicyVersion(
  pool: pg.Pool,
  policyId: string,
  version: number,
): Promise<PolicyVersionRecord | null> {
  const res = await pool.query<PolicyRow>(
    'SELECT policy_id, version, org_id, class, rules, created_at FROM policies WHERE policy_id = $1 AND version = $2',
    [policyId, version],
  );
  const row = res.rows[0];
  return row ? toPolicyRecord(row) : null;
}

export async function getLatestPolicyVersion(
  pool: pg.Pool,
  policyId: string,
): Promise<PolicyVersionRecord | null> {
  const res = await pool.query<PolicyRow>(
    'SELECT policy_id, version, org_id, class, rules, created_at FROM policies WHERE policy_id = $1 ORDER BY version DESC LIMIT 1',
    [policyId],
  );
  const row = res.rows[0];
  return row ? toPolicyRecord(row) : null;
}

export async function assignPolicy(
  pool: pg.Pool,
  params: {
    orgId: string;
    scope: 'org' | 'team' | 'agent';
    scopeId: string;
    policyId: string;
    class: PolicyClass;
  },
): Promise<string> {
  const id = newAssignmentId();
  await pool.query(
    'INSERT INTO policy_assignments (id, org_id, scope, scope_id, policy_id, class) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, params.orgId, params.scope, params.scopeId, params.policyId, params.class],
  );
  return id;
}

const SCOPE_RANK: Readonly<Record<string, number>> = { org: 0, team: 1, agent: 2 };

interface AssignedRow {
  scope: string;
  policy_id: string;
  version: number;
  rules: SpendPolicyJson | AllocationPolicyJson;
}

async function layersForClass(
  client: pg.PoolClient,
  orgId: string,
  teamId: string | null,
  agentId: string,
  cls: PolicyClass,
): Promise<{ rows: AssignedRow[]; ref: string | null }> {
  // Walk the full team ancestry up `parent_team_id` so an assignment on ANY ancestor team is
  // applied — a parent team can only narrow a child, never be silently dropped. When the agent
  // has no team, `id = $4` with $4 NULL matches nothing (NULL-safe), so there are no team layers.
  const res = await client.query<AssignedRow>(
    `WITH RECURSIVE team_ancestry AS (
         SELECT id, parent_team_id FROM teams WHERE id = $4
       UNION ALL
         SELECT t.id, t.parent_team_id FROM teams t JOIN team_ancestry a ON t.id = a.parent_team_id
     )
     SELECT a.scope, a.policy_id, p.version, p.rules
       FROM policy_assignments a
       JOIN LATERAL (
         SELECT version, rules FROM policies WHERE policy_id = a.policy_id ORDER BY version DESC LIMIT 1
       ) p ON true
      WHERE a.org_id = $1 AND a.class = $2
        AND ( (a.scope = 'org'   AND a.scope_id = $3)
           OR (a.scope = 'team'  AND a.scope_id IN (SELECT id FROM team_ancestry))
           OR (a.scope = 'agent' AND a.scope_id = $5) )`,
    [orgId, cls, orgId, teamId, agentId],
  );
  // Order root→leaf (org < team < agent). Intersection values are order-independent; ordering
  // only fixes the org layer first so the result's allowlist order is deterministic.
  const sorted = [...res.rows].sort(
    (x, y) => (SCOPE_RANK[x.scope] ?? 0) - (SCOPE_RANK[y.scope] ?? 0),
  );
  const leaf = sorted[sorted.length - 1];
  const ref = leaf ? `${leaf.policy_id}@v${leaf.version}` : null;
  return { rows: sorted, ref };
}

/**
 * Resolve the root→leaf policy layers that apply to an agent (org → team-ancestry → agent),
 * latest version of each, ready for {@link compileEffectivePolicy}. All reads run in a single
 * REPEATABLE READ snapshot so the org epoch and the policy rules are mutually consistent — a
 * concurrent edit can never produce a blob whose epoch and rules disagree.
 */
export async function getEffectiveLayers(
  pool: pg.Pool,
  agentId: string,
): Promise<{
  orgId: string;
  policyEpoch: number;
  spendLayers: SpendPolicy[];
  allocationLayers: AllocationPolicy[];
  spendPolicyRef: string | null;
  allocationPolicyRef: string | null;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    const agentRes = await client.query<{ org_id: string; team_id: string | null }>(
      'SELECT org_id, team_id FROM agents WHERE id = $1',
      [agentId],
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new Error(`unknown agent ${agentId}`);

    const orgRes = await client.query<{ policy_epoch: number }>(
      'SELECT policy_epoch FROM orgs WHERE id = $1',
      [agent.org_id],
    );
    const org = orgRes.rows[0];
    if (!org) throw new Error(`unknown org ${agent.org_id}`);

    const spend = await layersForClass(client, agent.org_id, agent.team_id, agentId, 'spend');
    const allocation = await layersForClass(
      client,
      agent.org_id,
      agent.team_id,
      agentId,
      'allocation',
    );

    await client.query('COMMIT');

    return {
      orgId: agent.org_id,
      policyEpoch: org.policy_epoch,
      spendLayers: spend.rows.map((r) => decodeSpend(r.rules as SpendPolicyJson)),
      allocationLayers: allocation.rows.map((r) =>
        decodeAllocation(r.rules as AllocationPolicyJson),
      ),
      spendPolicyRef: spend.ref,
      allocationPolicyRef: allocation.ref,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
