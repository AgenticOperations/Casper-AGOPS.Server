import type pg from 'pg';

export interface DelegatedKeyRecord {
  id: string;
  agentId: string;
  publicKey: string;
}

/** C.2: insert a new ACTIVE delegated key for an agent (grant). Weight is always 1 (D-2①). */
export async function grantDelegatedKey(
  pool: pg.Pool,
  input: { id: string; agentId: string; publicKey: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO delegated_keys (id, agent_id, public_key, weight, status)
     VALUES ($1, $2, $3, 1, 'ACTIVE')`,
    [input.id, input.agentId, input.publicKey],
  );
}

/**
 * C.2: rotation — mark the current ACTIVE key ROTATED (if one exists) and insert the new key as
 * ACTIVE. Leaves exactly one ACTIVE key for the agent at all times.
 */
export async function rotateDelegatedKey(
  pool: pg.Pool,
  input: { agentId: string; newId: string; newPublicKey: string },
): Promise<void> {
  const active = await readActiveDelegatedKey(pool, { agentId: input.agentId });
  if (active) {
    await pool.query(`UPDATE delegated_keys SET status = 'ROTATED' WHERE id = $1`, [active.id]);
  }
  await grantDelegatedKey(pool, { id: input.newId, agentId: input.agentId, publicKey: input.newPublicKey });
}

/** C.2: revoke — mark the agent's ACTIVE key REVOKED (D-2④). Leaves zero ACTIVE. */
export async function revokeDelegatedKey(pool: pg.Pool, input: { agentId: string }): Promise<void> {
  await pool.query(
    `UPDATE delegated_keys SET status = 'REVOKED', revoked_at = now()
      WHERE agent_id = $1 AND status = 'ACTIVE'`,
    [input.agentId],
  );
}

/** Used by signer resolution (B.4) to look up an agent's current delegated key, if any. */
export async function readActiveDelegatedKey(
  pool: pg.Pool,
  input: { agentId: string },
): Promise<DelegatedKeyRecord | null> {
  const result = await pool.query<{ id: string; public_key: string }>(
    `SELECT id, public_key FROM delegated_keys WHERE agent_id = $1 AND status = 'ACTIVE'`,
    [input.agentId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, agentId: input.agentId, publicKey: row.public_key } : null;
}

/** Half-2: promote the agent's ACTIVE delegated key to on-chain-granted after the master-signed
 * update_associated_keys deploy is confirmed. Idempotent (re-confirming the same hash is a no-op). */
export async function markDelegatedKeyGranted(
  pool: pg.Pool,
  input: { agentId: string; deployHash: string },
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE delegated_keys
        SET grant_state = 'granted', grant_deploy_hash = $2, granted_on_chain_at = now()
      WHERE agent_id = $1 AND status = 'ACTIVE'`,
    [input.agentId, input.deployHash],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ActiveDelegatedKeyRow {
  id: string;
  publicKey: string;
  grantState: 'pending' | 'granted';
  grantDeployHash: string | null;
}

/** The agent's ACTIVE delegated key with its on-chain grant state (for confirm + UI). */
export async function readActiveDelegatedKeyRow(
  pool: pg.Pool,
  agentId: string,
): Promise<ActiveDelegatedKeyRow | null> {
  const res = await pool.query<{
    id: string; public_key: string; grant_state: 'pending' | 'granted'; grant_deploy_hash: string | null;
  }>(
    `SELECT id, public_key, grant_state, grant_deploy_hash
       FROM delegated_keys WHERE agent_id = $1 AND status = 'ACTIVE'`,
    [agentId],
  );
  const r = res.rows[0];
  return r
    ? { id: r.id, publicKey: r.public_key, grantState: r.grant_state, grantDeployHash: r.grant_deploy_hash }
    : null;
}
