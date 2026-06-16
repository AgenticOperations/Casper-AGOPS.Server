import type pg from 'pg';
import { authenticatePrincipal } from '../identity/access/principal.js';

/**
 * Operator/P1 admin auth shim. Preserves the original {ok, orgId}|{ok:false,code:401,reason} contract so
 * existing control/treasury/policy/monitoring/reports routes need no change, but delegates to the unified
 * authenticatePrincipal — so the api_keys table (new sk_ home) and the legacy orgs.admin_key_hash fallback
 * are both honored. Bearer-only (no cookie passed here): cookie-bearing routes use requireRole directly.
 * ag_ keys remain fenced out (the resolver rejects them).
 */
export type AdminOutcome = { ok: true; orgId: string } | { ok: false; code: 401; reason: string };

export async function authenticateAdmin(
  pool: pg.Pool,
  authzHeader: string | undefined,
): Promise<AdminOutcome> {
  const out = await authenticatePrincipal(pool, {
    cookieHeader: undefined,
    authzHeader,
    cookieName: 'agentops_session',
  });
  if (out.ok) return { ok: true, orgId: out.principal.orgId };
  return { ok: false, code: 401, reason: out.reason };
}
