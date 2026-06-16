import type pg from 'pg';
import { newMembershipId } from '../../../lib/ids.js';
import type { Role } from './roles.js';

export interface MembershipRecord {
  id: string;
  userId: string;
  orgId: string;
  role: Role;
}

export async function addMembership(
  pool: pg.Pool,
  params: { userId: string; orgId: string; role: Role },
): Promise<MembershipRecord> {
  const id = newMembershipId();
  await pool.query('INSERT INTO memberships (id, user_id, org_id, role) VALUES ($1,$2,$3,$4)', [
    id,
    params.userId,
    params.orgId,
    params.role,
  ]);
  return { id, userId: params.userId, orgId: params.orgId, role: params.role };
}

/**
 * Idempotent membership: insert (user, org, role) unless the user is ALREADY a member, in which case the
 * existing row is left untouched (no role change, no duplicate). Used by invitation-accept, which may be
 * replayed for an already-joined user — the invite is still consumed, but membership must not duplicate.
 * Returns whether a NEW membership was created.
 */
export async function ensureMembership(
  pool: pg.Pool,
  params: { userId: string; orgId: string; role: Role },
): Promise<{ created: boolean }> {
  const res = await pool.query(
    `INSERT INTO memberships (id, user_id, org_id, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, org_id) DO NOTHING`,
    [newMembershipId(), params.userId, params.orgId, params.role],
  );
  return { created: (res.rowCount ?? 0) > 0 };
}

/** All orgs a user belongs to, with role. */
export async function listMembershipsForUser(
  pool: pg.Pool,
  userId: string,
): Promise<Array<{ orgId: string; role: Role; orgName: string }>> {
  const res = await pool.query<{ org_id: string; role: Role; name: string }>(
    `SELECT m.org_id, m.role, o.name FROM memberships m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY m.created_at ASC`,
    [userId],
  );
  return res.rows.map((r) => ({ orgId: r.org_id, role: r.role, orgName: r.name }));
}

/** A user's role in a specific org, or null if not a member. */
export async function roleInOrg(
  pool: pg.Pool,
  userId: string,
  orgId: string,
): Promise<Role | null> {
  const res = await pool.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2',
    [userId, orgId],
  );
  return res.rows[0]?.role ?? null;
}
