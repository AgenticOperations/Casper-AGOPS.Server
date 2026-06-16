import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticatePrincipal, requireRole } from './principal.js';
import { satisfiesRole, type Role } from './roles.js';
import type { PrincipalOutcome } from './principal.js';

/**
 * The header a human with multiple org memberships uses to pick the active org on NON-path-scoped
 * control reads/writes (the console org switcher sets it). Path-scoped routes already carry the org in
 * `:id` and govern via the tenant-fence, so the header is ignored there. An sk_ key is bound to exactly
 * one org, so the header never applies to a key (selection lives only in the session branch of
 * `authenticatePrincipal`). Lower-case: Fastify normalises request header names.
 */
export const ORG_SELECTION_HEADER = 'x-agentops-org';

function readSelectedOrg(request: FastifyRequest): string | undefined {
  const raw = request.headers[ORG_SELECTION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Route-level guard: accepts EITHER the session cookie OR an sk_ Bearer, enforces a minimum role, and
 * (when orgId is supplied) tenant-fences to that org. One call replaces the per-route `authenticateAdmin`
 * for routes that should also accept human sessions. Returns the unified PrincipalOutcome.
 *
 * Two org-resolution modes:
 *   - Path-scoped (`forOrgId` given): select + tenant-fence to that org — a principal that does not own
 *     it gets 404 (no cross-org existence leak), preserving the prior contract.
 *   - Non-path-scoped (`forOrgId` omitted): a session user may SELECT the active org via the
 *     `X-AgentOps-Org` header (403 if not a member, no leak); with no header it defaults to the first
 *     membership (backward-compatible). A key ignores the header and resolves to its own org.
 */
export function authForRoute(
  app: FastifyInstance,
  request: FastifyRequest,
  min: Role,
  forOrgId?: string,
): Promise<PrincipalOutcome> {
  const base = {
    cookieHeader: request.headers.cookie,
    authzHeader: request.headers.authorization,
    cookieName: app.deps.env.SESSION_COOKIE_NAME,
  };

  if (forOrgId !== undefined) {
    return requireRole(app.deps.pg, base, min, forOrgId);
  }

  return selectAndAuthorize(app, base, min, readSelectedOrg(request));
}

async function selectAndAuthorize(
  app: FastifyInstance,
  base: { cookieHeader: string | undefined; authzHeader: string | undefined; cookieName: string },
  min: Role,
  requestedOrgId: string | undefined,
): Promise<PrincipalOutcome> {
  const out = await authenticatePrincipal(app.deps.pg, {
    ...base,
    ...(requestedOrgId !== undefined ? { requestedOrgId } : {}),
  });
  if (!out.ok) return out;
  // No tenant-fence here: `authenticatePrincipal` already 403s a session user who names a non-member
  // org, and a key resolves to its own org (header ignored). Only the role floor remains to enforce.
  if (!satisfiesRole(out.principal.role, min)) {
    return { ok: false, code: 403, reason: 'insufficient_role' };
  }
  return out;
}
