import type pg from 'pg';
import { hashApiKey } from '../../lib/ids.js';

/**
 * E9 Oracle authentication — resolve a per-agent bearer to a tenant-bound identity, fail-closed.
 *
 * Two credential classes exist and never mix on the hot path (doc 03 §9):
 *  - `ag_live_…`  per-agent bearer — the ONLY credential that authorizes a payment.
 *  - `sk_live_…`  org admin session key — fenced out here BEFORE any lookup, so an admin key can
 *                 never move money even if it leaked onto the agent surface.
 *
 * We look the agent up by the SHA-256 hash of the presented token against the unique
 * `agents.api_key_hash` index. The token is 192-bit high-entropy, so an indexed hash-equality lookup
 * is the correct primitive (no per-character compare in our code path to time); the plaintext token
 * is never stored. A miss, an admin key, a malformed header, or a NON-ACTIVE agent all yield no
 * identity — the route then refuses to authorize.
 *
 * Status fence (fail-closed, allowlist): ONLY status === 'active' authorizes. Every other state —
 * 'suspended' (M8 kill-switch) and 'retired' (0007 terminal lifecycle) — is denied. Allowlisting
 * 'active' (rather than denylisting specific states) means any future lifecycle status is denied by
 * default; a retired agent's ag_ stops moving money the instant its row flips.
 */

export interface AuthedAgent {
  agentId: string;
  orgId: string;
}

export type AuthOutcome =
  | { ok: true; agent: AuthedAgent }
  | { ok: false; code: 401 | 403; reason: string };

const BEARER_PREFIX = 'Bearer ';

export async function authenticateAgent(
  pool: pg.Pool,
  authzHeader: string | undefined,
): Promise<AuthOutcome> {
  if (!authzHeader || !authzHeader.startsWith(BEARER_PREFIX)) {
    return { ok: false, code: 401, reason: 'missing_bearer_token' };
  }
  const token = authzHeader.slice(BEARER_PREFIX.length).trim();

  // Admin session keys are fenced out of the hot path BEFORE any database lookup.
  if (token.startsWith('sk_')) {
    return { ok: false, code: 401, reason: 'admin_key_not_permitted' };
  }
  // Only the per-agent bearer class is accepted; anything else is rejected without leaking which.
  if (!token.startsWith('ag_')) {
    return { ok: false, code: 401, reason: 'invalid_token' };
  }

  const res = await pool.query<{ id: string; org_id: string; status: string }>(
    'SELECT id, org_id, status FROM agents WHERE api_key_hash = $1',
    [hashApiKey(token)],
  );
  const row = res.rows[0];
  if (!row) {
    return { ok: false, code: 401, reason: 'invalid_token' };
  }
  // Allowlist: only 'active' authorizes. 'suspended' and 'retired' (and any future state) are denied.
  if (row.status !== 'active') {
    return { ok: false, code: 403, reason: 'agent_suspended' };
  }
  return { ok: true, agent: { agentId: row.id, orgId: row.org_id } };
}
