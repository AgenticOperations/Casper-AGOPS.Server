import type { FastifyInstance } from 'fastify';
import { parseCookies } from '../../../lib/cookies.js';
import { resolveSession } from './session-store.js';
import { findUserById } from './user-store.js';
import { listMembershipsForUser } from '../access/membership-store.js';

/**
 * Current user + their org memberships. The frontend uses this to populate the org switcher. Authenticated
 * by session cookie only (this is a human surface). A user with NO memberships is valid — they simply get
 * an empty `orgs` array (the first-org-creation entry state), never an error. Fail-closed: no/invalid
 * session → 401.
 */
export function registerMeRoutes(app: FastifyInstance): void {
  app.get('/v1/me', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const token = parseCookies(request.headers.cookie)[env.SESSION_COOKIE_NAME];
    if (!token) return reply.code(401).send({ error: 'unauthenticated' });
    const sess = await resolveSession(pool, token);
    if (!sess) return reply.code(401).send({ error: 'invalid_session' });

    const user = await findUserById(pool, sess.userId);
    if (!user) return reply.code(401).send({ error: 'invalid_session' });
    const memberships = await listMembershipsForUser(pool, sess.userId);

    return reply.code(200).send({
      user: { id: user.id, email: user.email, name: user.name, email_verified: user.emailVerified },
      orgs: memberships.map((m) => ({ org_id: m.orgId, role: m.role, name: m.orgName })),
    });
  });
}
