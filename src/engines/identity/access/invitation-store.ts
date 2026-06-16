import type pg from 'pg';
import { newTokenRowId, issueOpaqueToken, hashApiKey } from '../../../lib/ids.js';
import type { Role } from './roles.js';

/**
 * Org invitations — a single-use, TTL'd token the OWNER mints to invite a human (by email) to join as
 * 'admin' or 'member'. Same posture as token-store.ts (email-verify / reset): persist ONLY the sha256
 * hash; the plaintext rides the emailed accept link. Consume is atomic — one UPDATE marks the invite
 * accepted iff it is still live and unused, so a reused or expired token consumes nothing.
 */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000; // 72h

/** The role an invite may grant — never 'owner' (ownership is bootstrapped, never invited). */
export type InvitableRole = Extract<Role, 'admin' | 'member'>;

export interface InvitationRecord {
  id: string;
  orgId: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  created_at: Date;
  expires_at: Date;
}

const toRecord = (r: InvitationRow): InvitationRecord => ({
  id: r.id,
  orgId: r.org_id,
  email: r.email,
  role: r.role,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

/**
 * Mint an invitation: persist the sha256 hash + TTL, return the row AND the one-time plaintext token (it
 * goes only into the emailed accept link, never persisted or logged beyond the dev-transport link).
 */
export async function createInvitation(
  pool: pg.Pool,
  params: { orgId: string; email: string; role: InvitableRole; invitedBy: string | null },
): Promise<{ record: InvitationRecord; token: string }> {
  const id = newTokenRowId();
  const { token, hash } = issueOpaqueToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  const res = await pool.query<{ created_at: Date; expires_at: Date }>(
    `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING created_at, expires_at`,
    [id, params.orgId, params.email, params.role, hash, params.invitedBy, expiresAt],
  );
  const row = res.rows[0];
  if (!row) throw new Error('createInvitation: INSERT ... RETURNING produced no row');
  return {
    token,
    record: {
      id,
      orgId: params.orgId,
      email: params.email,
      role: params.role,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    },
  };
}

/**
 * Atomically consume an invite: marks accepted_at iff live + unused, returning its org/email/role in the
 * SAME statement. A reused, expired, or unknown token matches nothing → null (the caller answers 400).
 */
export async function consumeInvitation(
  pool: pg.Pool,
  token: string,
): Promise<{ orgId: string; email: string; role: Role } | null> {
  const res = await pool.query<{ org_id: string; email: string; role: Role }>(
    `UPDATE invitations SET accepted_at = now()
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
       RETURNING org_id, email, role`,
    [hashApiKey(token)],
  );
  const row = res.rows[0];
  return row ? { orgId: row.org_id, email: row.email, role: row.role } : null;
}

/** Pending invitations for an org: not yet accepted and not yet expired. Newest first. */
export async function listPendingInvitations(
  pool: pg.Pool,
  orgId: string,
): Promise<InvitationRecord[]> {
  const res = await pool.query<InvitationRow>(
    `SELECT id, org_id, email, role, created_at, expires_at
       FROM invitations
      WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [orgId],
  );
  return res.rows.map(toRecord);
}
