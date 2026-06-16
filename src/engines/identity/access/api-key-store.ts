import type pg from 'pg';
import { newApiKeyId, issueAdminKey, type IssuedKey } from '../../../lib/ids.js';

/**
 * api_keys system of record — the new home for rotatable sk_live_ keys (multiple per org, revocable,
 * last-used tracked). The unified principal resolver (P1c) authenticates an sk_ Bearer against THIS table
 * first; the legacy orgs.admin_key_hash column is only a transition fallback. Only the sha256 hash is
 * persisted; the plaintext is shown once at issue.
 */
export interface ApiKeyRecord {
  id: string;
  orgId: string;
  label: string;
  prefix: string;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface KeyRow {
  id: string;
  org_id: string;
  label: string;
  prefix: string;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const toRecord = (r: KeyRow): ApiKeyRecord => ({
  id: r.id,
  orgId: r.org_id,
  label: r.label,
  prefix: r.prefix,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

/**
 * Insert an api_keys row for a key whose hash is already known. This is the reconciling seam used by
 * org-create: the org's single admin key is minted ONCE, its hash lands in orgs.admin_key_hash (via
 * createOrg) AND in this row with the SAME key_hash, so there is exactly one logical credential — the
 * resolver finds it here, and a later revoke is honoured (the legacy fallback never re-authenticates it).
 */
export async function insertApiKeyRow(
  pool: pg.Pool,
  params: { orgId: string; keyHash: string; label?: string; createdBy?: string | null },
): Promise<ApiKeyRecord> {
  const id = newApiKeyId();
  const res = await pool.query<{ created_at: Date }>(
    `INSERT INTO api_keys (id, org_id, key_hash, label, prefix, created_by)
     VALUES ($1,$2,$3,$4,'sk_live',$5) RETURNING created_at`,
    [id, params.orgId, params.keyHash, params.label ?? '', params.createdBy ?? null],
  );
  return {
    id,
    orgId: params.orgId,
    label: params.label ?? '',
    prefix: 'sk_live',
    createdBy: params.createdBy ?? null,
    createdAt: res.rows[0]!.created_at.toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
}

/** Mint a fresh sk_live_ key, persist only its hash, and return BOTH the row and the one-time token. */
export async function issueApiKey(
  pool: pg.Pool,
  params: { orgId: string; label?: string; createdBy?: string | null },
): Promise<{ record: ApiKeyRecord; token: string }> {
  const key: IssuedKey = issueAdminKey(); // sk_live_… token + sha256 hash
  const record = await insertApiKeyRow(pool, {
    orgId: params.orgId,
    keyHash: key.hash,
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.createdBy !== undefined ? { createdBy: params.createdBy } : {}),
  });
  return { token: key.token, record };
}

export async function listApiKeys(pool: pg.Pool, orgId: string): Promise<ApiKeyRecord[]> {
  const res = await pool.query<KeyRow>(
    `SELECT id, org_id, label, prefix, created_by, created_at, last_used_at, revoked_at
       FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
  return res.rows.map(toRecord);
}

/** Revoke one key, tenant-fenced. Returns true if a live key was revoked. */
export async function revokeApiKey(pool: pg.Pool, orgId: string, keyId: string): Promise<boolean> {
  const res = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL',
    [keyId, orgId],
  );
  return (res.rowCount ?? 0) > 0;
}
