import type pg from 'pg';
import { parseCookies } from '../../../lib/cookies.js';
import { hashApiKey } from '../../../lib/ids.js';
import { resolveSession } from '../account/session-store.js';
import { listMembershipsForUser } from './membership-store.js';
import { KEY_ROLE, satisfiesRole, type Role } from './roles.js';

/**
 * The uniform identity every protected admin/control route resolves. Two actor types collapse to ONE
 * shape so handlers branch on role/orgId, never on credential class:
 *   - user — a human via the session cookie; orgId is the selected org they are a member of.
 *   - key  — an sk_ machine key via Bearer; role is KEY_ROLE ('admin'), orgId is the key's org.
 *
 * Coexistence + transition: an sk_ Bearer is resolved against api_keys FIRST (the new home, multiple +
 * rotatable), then falls back to the legacy orgs.admin_key_hash so EVERY existing key keeps working.
 * The ag_ hot-path class is fenced OUT here exactly as the old admin-auth did — an agent key can never
 * reach the control plane.
 */
export interface Principal {
  orgId: string;
  role: Role;
  actorType: 'user' | 'key';
  userId?: string;
}

export type PrincipalOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; code: 401 | 403 | 404; reason: string };

const BEARER_PREFIX = 'Bearer ';

export interface PrincipalInput {
  cookieHeader: string | undefined;
  authzHeader: string | undefined;
  cookieName: string;
  /** Optional org selection for a user with multiple memberships (header or query). */
  requestedOrgId?: string;
}

export async function authenticatePrincipal(
  pool: pg.Pool,
  input: PrincipalInput,
): Promise<PrincipalOutcome> {
  // 1. sk_ Bearer (machine key) takes precedence when present — it is an explicit credential.
  const authz = input.authzHeader;
  if (authz && authz.startsWith(BEARER_PREFIX)) {
    const token = authz.slice(BEARER_PREFIX.length).trim();
    if (token.startsWith('ag_')) return { ok: false, code: 401, reason: 'agent_key_not_permitted' };
    if (!token.startsWith('sk_')) return { ok: false, code: 401, reason: 'invalid_token' };
    const hash = hashApiKey(token);

    // 1a. New api_keys table (non-revoked).
    const keyRes = await pool.query<{ id: string; org_id: string }>(
      'SELECT id, org_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hash],
    );
    if (keyRes.rows[0]) {
      // best-effort last-used touch; never blocks auth.
      void pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyRes.rows[0].id]);
      return {
        ok: true,
        principal: { orgId: keyRes.rows[0].org_id, role: KEY_ROLE, actorType: 'key' },
      };
    }
    // 1b. The active-row lookup missed. Before any legacy fallback, decide WHY it missed: a key that is
    // KNOWN to api_keys (any status) but inactive is REVOKED — it must be rejected, never re-authenticated
    // through the legacy column. Migration 0006 backfilled every orgs.admin_key_hash into api_keys with the
    // SAME key_hash, so without this gate a revoked key would bypass revocation via 1c. Only a key that is
    // entirely ABSENT from api_keys (a pre-migration key never backfilled) is eligible for the legacy path.
    const known = await pool.query('SELECT 1 FROM api_keys WHERE key_hash = $1', [hash]);
    if (known.rows[0]) return { ok: false, code: 401, reason: 'invalid_admin_key' };

    // 1c. Legacy fallback: orgs.admin_key_hash (pre-migration keys not present in api_keys at all).
    const legacy = await pool.query<{ id: string }>(
      'SELECT id FROM orgs WHERE admin_key_hash = $1',
      [hash],
    );
    if (legacy.rows[0]) {
      return { ok: true, principal: { orgId: legacy.rows[0].id, role: KEY_ROLE, actorType: 'key' } };
    }
    return { ok: false, code: 401, reason: 'invalid_admin_key' };
  }

  // 2. Session cookie (human).
  const token = parseCookies(input.cookieHeader)[input.cookieName];
  if (!token) return { ok: false, code: 401, reason: 'unauthenticated' };
  const sess = await resolveSession(pool, token);
  if (!sess) return { ok: false, code: 401, reason: 'invalid_session' };

  const memberships = await listMembershipsForUser(pool, sess.userId);
  if (memberships.length === 0) return { ok: false, code: 403, reason: 'no_org_membership' };

  // Org selection: requested org if a member; else the first (default) membership.
  let chosen = memberships[0];
  if (input.requestedOrgId) {
    const match = memberships.find((m) => m.orgId === input.requestedOrgId);
    if (!match) return { ok: false, code: 403, reason: 'not_a_member_of_org' };
    chosen = match;
  }
  if (!chosen) return { ok: false, code: 403, reason: 'no_org_membership' };
  return {
    ok: true,
    principal: { orgId: chosen.orgId, role: chosen.role, actorType: 'user', userId: sess.userId },
  };
}

/**
 * Guard helper: resolve the principal from a Fastify request and enforce a minimum role, scoped to the
 * org the route addresses (when `forOrgId` is given, a user must be a member of THAT org with min role;
 * a key must own it). Returns the principal on success, or an outcome to `reply.code(...).send(...)`.
 */
export async function requireRole(
  pool: pg.Pool,
  req: { cookieHeader: string | undefined; authzHeader: string | undefined; cookieName: string },
  min: Role,
  forOrgId?: string,
): Promise<PrincipalOutcome> {
  const out = await authenticatePrincipal(pool, {
    ...req,
    ...(forOrgId !== undefined ? { requestedOrgId: forOrgId } : {}),
  });
  if (!out.ok) return out;
  const p = out.principal;
  // Tenant fence: when the route addresses a specific org, the resolved principal must own it. A user is
  // already member-scoped above; a key resolves to exactly one org, so a mismatch is a cross-tenant probe
  // — answer 404 (no cross-org existence leak), matching the existing routes' tenant-fence contract.
  if (forOrgId && p.orgId !== forOrgId) return { ok: false, code: 404, reason: 'org_not_found' };
  if (!satisfiesRole(p.role, min)) return { ok: false, code: 403, reason: 'insufficient_role' };
  return out;
}
