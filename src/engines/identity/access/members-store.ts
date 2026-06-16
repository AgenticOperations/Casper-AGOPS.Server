import type pg from 'pg';
import type { Role } from './roles.js';

/**
 * Member management reads/writes over the memberships table (joined to users for display). Pairs with
 * membership-store.ts (the bootstrap/add seam) — this file is the OWNER-driven management surface: list
 * with user detail, count owners (the last-owner invariant), change a role, remove a member. The
 * last-owner invariant (an org must always keep >= 1 owner) is enforced in the routes using countOwners;
 * these functions are kept pure (one statement, no side reads) so the route composes the guard.
 */
export interface MemberWithUser {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

interface MemberRow {
  user_id: string;
  email: string;
  name: string;
  role: Role;
}

/** Members of an org with their user email/name, oldest membership first. */
export async function listMembersWithUsers(pool: pg.Pool, orgId: string): Promise<MemberWithUser[]> {
  const res = await pool.query<MemberRow>(
    `SELECT m.user_id, u.email, u.name, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC`,
    [orgId],
  );
  return res.rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role }));
}

/** How many owners the org currently has — the basis of the last-owner invariant. */
export async function countOwners(pool: pg.Pool, orgId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`,
    [orgId],
  );
  return Number(res.rows[0]?.n ?? '0');
}

/** Change a member's role, tenant-fenced. Returns true iff a member row was updated. */
export async function updateMemberRole(
  pool: pg.Pool,
  orgId: string,
  userId: string,
  role: Role,
): Promise<boolean> {
  const res = await pool.query(
    'UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2',
    [orgId, userId, role],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Remove a member, tenant-fenced. Returns true iff a member row was deleted. */
export async function removeMember(pool: pg.Pool, orgId: string, userId: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [
    orgId,
    userId,
  ]);
  return (res.rowCount ?? 0) > 0;
}
