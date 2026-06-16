import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseCookies } from '../../../lib/cookies.js';
import { resolveSession } from '../account/session-store.js';
import { findUserByEmail, findUserById } from '../account/user-store.js';
import { authForRoute } from '../access/route-guard.js';
import { ensureMembership, roleInOrg } from '../access/membership-store.js';
import {
  listMembersWithUsers,
  countOwners,
  updateMemberRole,
  removeMember,
} from '../access/members-store.js';
import {
  createInvitation,
  consumeInvitation,
  listPendingInvitations,
} from '../access/invitation-store.js';
import type { Role } from '../access/roles.js';

/**
 * Member management (Members & RBAC) — the OWNER-driven access surface over an org's memberships +
 * invitations. Every :id route is tenant-fenced via authForRoute(forOrgId): a principal that does not
 * own the org gets 404 (no cross-org existence leak). Role floors are exact: list is ADMIN+, all
 * mutations (invite/role/remove) are OWNER. Two security invariants hold throughout:
 *   - Last-owner protection: a role change or removal that would leave the org with ZERO owners → 409.
 *   - Invitation tokens are single-use + TTL'd (72h), sha256-at-rest, consumed atomically. The accept
 *     route additionally fences on email match (the session user's email must equal the invite's).
 * Invites never reveal whether the email already has an account — same 201 shape either way.
 */
const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']), // never 'owner' via invite — ownership is bootstrapped, not invited
});
const AcceptBody = z.object({ token: z.string().min(1) });
const RoleBody = z.object({ role: z.enum(['owner', 'admin', 'member']) });

export function registerMembersRoutes(app: FastifyInstance): void {
  // 1. List members + pending invitations (ADMIN+).
  app.get('/v1/orgs/:id/members', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId } = request.params as { id: string };
    const auth = await authForRoute(app, request, 'admin', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const [members, invitations] = await Promise.all([
      listMembersWithUsers(pool, orgId),
      listPendingInvitations(pool, orgId),
    ]);
    return reply.code(200).send({
      members: members.map((m) => ({
        user_id: m.userId,
        email: m.email,
        name: m.name,
        role: m.role,
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        created_at: i.createdAt,
        expires_at: i.expiresAt,
      })),
    });
  });

  // 2. Invite a human by email (OWNER). Does NOT leak whether the email has an account.
  app.post('/v1/orgs/:id/members/invite', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const { id: orgId } = request.params as { id: string };
    const auth = await authForRoute(app, request, 'owner', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = InviteBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { email, role } = parsed.data;

    // If the email already maps to a user who is ALREADY a member of THIS org → 409 (not a leak: an
    // owner inviting their own org's existing member legitimately learns they're already in). For any
    // other email (no account, or an account not in this org) we proceed to a normal invite.
    const existing = await findUserByEmail(pool, email);
    if (existing && (await roleInOrg(pool, existing.id, orgId)) !== null) {
      return reply.code(409).send({ error: 'already_member' });
    }

    const invitedBy = auth.principal.actorType === 'user' ? (auth.principal.userId ?? null) : null;
    const { record, token } = await createInvitation(pool, { orgId, email, role, invitedBy });
    await app.deps.email!.send({
      to: email,
      subject: 'You have been invited to an agentOps organization',
      kind: 'org_invitation',
      link: `${env.APP_BASE_URL}/invitations/accept?token=${token}`,
    });
    return reply.code(201).send({
      invitation: { id: record.id, email: record.email, role: record.role, expires_at: record.expiresAt },
    });
  });

  // 3. Accept an invitation (SESSION required — the accepting human). Email must match (case-insensitive).
  app.post('/v1/invitations/accept', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const token = parseCookies(request.headers.cookie)[env.SESSION_COOKIE_NAME];
    if (!token) return reply.code(401).send({ error: 'unauthenticated' });
    const sess = await resolveSession(pool, token);
    if (!sess) return reply.code(401).send({ error: 'invalid_session' });

    const parsed = AcceptBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const user = await findUserById(pool, sess.userId);
    if (!user) return reply.code(401).send({ error: 'invalid_session' });

    // Atomic single-use consume FIRST (invalid/expired/used → nothing matches). Then enforce the email
    // fence: the session user's email must equal the invite's (case-insensitive). On a mismatch the
    // invite is already consumed — acceptable: a token sent to the wrong human is now spent, not reusable.
    const invite = await consumeInvitation(pool, parsed.data.token);
    if (!invite) return reply.code(400).send({ error: 'invalid_or_expired_invitation' });
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return reply.code(403).send({ error: 'invitation_email_mismatch' });
    }

    // Idempotent: if already a member, the membership is left as-is (no dup, no role change) and we 200.
    await ensureMembership(pool, { userId: user.id, orgId: invite.orgId, role: invite.role });
    return reply.code(200).send({ org_id: invite.orgId, role: invite.role });
  });

  // 4. Change a member's role (OWNER). Never demote the last owner.
  app.patch('/v1/orgs/:id/members/:userId/role', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId, userId } = request.params as { id: string; userId: string };
    const auth = await authForRoute(app, request, 'owner', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = RoleBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const newRole: Role = parsed.data.role;

    const current = await roleInOrg(pool, userId, orgId);
    if (current === null) return reply.code(404).send({ error: 'member_not_found' });

    // Last-owner invariant: demoting the ONLY owner away from 'owner' would orphan the org → 409.
    if (current === 'owner' && newRole !== 'owner' && (await countOwners(pool, orgId)) <= 1) {
      return reply.code(409).send({ error: 'last_owner' });
    }

    await updateMemberRole(pool, orgId, userId, newRole);
    return reply.code(200).send({ user_id: userId, role: newRole });
  });

  // 5. Remove a member (OWNER). Never remove the last owner (self-removal allowed unless last owner).
  app.delete('/v1/orgs/:id/members/:userId', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId, userId } = request.params as { id: string; userId: string };
    const auth = await authForRoute(app, request, 'owner', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const current = await roleInOrg(pool, userId, orgId);
    if (current === null) return reply.code(404).send({ error: 'member_not_found' });

    // Last-owner invariant: removing the ONLY owner would orphan the org → 409.
    if (current === 'owner' && (await countOwners(pool, orgId)) <= 1) {
      return reply.code(409).send({ error: 'last_owner' });
    }

    await removeMember(pool, orgId, userId);
    return reply.code(204).send();
  });
}
