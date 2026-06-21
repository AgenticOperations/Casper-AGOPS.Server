import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  seedUserOrgOwner,
  seedMemberOnOrg,
  type IdStores,
} from '../helpers/identity-harness.js';
import { createUser } from '../../src/engines/identity/account/user-store.js';
import { createSession } from '../../src/engines/identity/account/session-store.js';
import { createInvitation } from '../../src/engines/identity/access/invitation-store.js';
import { hashApiKey } from '../../src/lib/ids.js';
import type { DevLogEmailTransport } from '../../src/lib/email/transport.js';

let stores: IdStores | null = null;
let app: FastifyInstance | undefined;
let email: DevLogEmailTransport | undefined;

beforeAll(async () => {
  stores = await startIdStores();
  if (stores) {
    const built = buildIdApp(stores.pool, stores.redis);
    app = built.app;
    email = built.email;
  }
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stopIdStores(stores);
});

/** Extract the ?token= from an accept link captured by the dev transport. */
function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token')!;
}

/** Seed a verified user + a usable session cookie, with NO org membership. */
async function seedSessionUser(
  pool: import('pg').Pool,
  emailAddr: string,
): Promise<{ userId: string; cookie: string }> {
  const user = await createUser(pool, {
    email: emailAddr,
    passwordHash: 'scrypt$x',
    emailVerified: true,
    name: 'Invitee',
  });
  const { token } = await createSession(pool, user.id);
  return { userId: user.id, cookie: `agentops_session=${token}` };
}

describe('GET /v1/orgs/:id/members', () => {
  it('an ADMIN can list members + pending invitations', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'list-owner@test.com');
    const adminCookie = (
      await seedMemberOnOrg(stores.pool, owner.orgId, 'list-admin@test.com', 'admin')
    ).cookie;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${owner.orgId}/members`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      members: Array<{ user_id: string; email: string; name: string; role: string }>;
      invitations: unknown[];
    }>();
    expect(body.members.some((m) => m.email === 'list-owner@test.com' && m.role === 'owner')).toBe(
      true,
    );
    expect(body.members.some((m) => m.email === 'list-admin@test.com' && m.role === 'admin')).toBe(
      true,
    );
    expect(Array.isArray(body.invitations)).toBe(true);
  });

  it('a MEMBER (below admin floor) is 403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'list-mfloor-owner@test.com');
    const memberCookie = (
      await seedMemberOnOrg(stores.pool, owner.orgId, 'list-member@test.com', 'member')
    ).cookie;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${owner.orgId}/members`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cross-org probe is fenced (no existence leak) → 403/404', async ({ skip }) => {
    if (!stores || !app) return skip();
    const a = await seedUserOrgOwner(stores.pool, 'xorg-a@test.com');
    const b = await seedUserOrgOwner(stores.pool, 'xorg-b@test.com');
    // A session user who is a member of A but NOT of B is rejected at the principal layer (403
    // not_a_member_of_org); a key bound to one org probing another is 404. Both fence the same way:
    // no cross-org member data is ever returned (matches the api-key-routes tenant-fence contract).
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${b.orgId}/members`,
      headers: { cookie: a.cookie },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('POST /v1/orgs/:id/members/invite', () => {
  it('OWNER invites; an invitation is created and the accept link is emailed', async ({ skip }) => {
    if (!stores || !app || !email) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'inv-owner@test.com');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'newbie@test.com', role: 'member' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ invitation: { id: string; email: string; role: string; expires_at: string } }>();
    expect(body.invitation.email).toBe('newbie@test.com');
    expect(body.invitation.role).toBe('member');

    const msg = email.lastFor('newbie@test.com', 'org_invitation');
    expect(msg).toBeDefined();
    expect(msg!.link).toContain('/invitations/accept?token=');
    // The token in the link consumes the invite (sha256-at-rest: link token != stored hash).
    const token = tokenFromLink(msg!.link);
    const row = await stores.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM invitations WHERE id = $1',
      [body.invitation.id],
    );
    expect(row.rows[0]?.token_hash).toBe(hashApiKey(token));
  });

  it('inviting an email that is ALREADY a member of this org is 409', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'inv409-owner@test.com');
    await seedMemberOnOrg(stores.pool, owner.orgId, 'already@test.com', 'member');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'already@test.com', role: 'member' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('already_member');
  });

  it('cannot invite as owner (zod rejects role=owner) → 400', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'inv-noowner@test.com');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'wannabe@test.com', role: 'owner' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a non-owner (admin) cannot invite → 403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'inv-adminfloor-owner@test.com');
    const adminCookie = (
      await seedMemberOnOrg(stores.pool, owner.orgId, 'inv-admin@test.com', 'admin')
    ).cookie;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: adminCookie },
      payload: { email: 'someone@test.com', role: 'member' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does NOT leak whether the email has an account (201 for an unknown email too)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'inv-noleak-owner@test.com');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'no-account-here@test.com', role: 'admin' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /v1/invitations/accept', () => {
  it('the matching-email session user accepts and becomes a member', async ({ skip }) => {
    if (!stores || !app || !email) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'acc-owner@test.com');
    const invitee = await seedSessionUser(stores.pool, 'acc-invitee@test.com');

    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'acc-invitee@test.com', role: 'admin' },
    });
    const token = tokenFromLink(email.lastFor('acc-invitee@test.com', 'org_invitation')!.link);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { cookie: invitee.cookie },
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ org_id: string; role: string }>();
    expect(body.org_id).toBe(owner.orgId);
    expect(body.role).toBe('admin');

    const m = await stores.pool.query<{ role: string }>(
      'SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2',
      [invitee.userId, owner.orgId],
    );
    expect(m.rows[0]?.role).toBe('admin');
  });

  it('accept by a session user whose email does NOT match the invite → 403', async ({ skip }) => {
    if (!stores || !app || !email) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'mis-owner@test.com');
    const wrong = await seedSessionUser(stores.pool, 'wrong-human@test.com');

    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'intended@test.com', role: 'member' },
    });
    const token = tokenFromLink(email.lastFor('intended@test.com', 'org_invitation')!.link);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { cookie: wrong.cookie },
      payload: { token },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('invitation_email_mismatch');
  });

  it('a used token cannot be re-accepted → 400', async ({ skip }) => {
    if (!stores || !app || !email) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'used-owner@test.com');
    const invitee = await seedSessionUser(stores.pool, 'used-invitee@test.com');

    await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.orgId}/members/invite`,
      headers: { cookie: owner.cookie },
      payload: { email: 'used-invitee@test.com', role: 'member' },
    });
    const token = tokenFromLink(email.lastFor('used-invitee@test.com', 'org_invitation')!.link);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { cookie: invitee.cookie },
      payload: { token },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { cookie: invitee.cookie },
      payload: { token },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ error: string }>().error).toBe('invalid_or_expired_invitation');
  });

  it('an expired invitation token → 400', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'exp-owner@test.com');
    const invitee = await seedSessionUser(stores.pool, 'exp-invitee@test.com');
    // Mint an invite directly, then force its expiry into the past.
    const { record, token } = await createInvitation(stores.pool, {
      orgId: owner.orgId,
      email: 'exp-invitee@test.com',
      role: 'member',
      invitedBy: owner.userId,
    });
    await stores.pool.query(`UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      record.id,
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { cookie: invitee.cookie },
      payload: { token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_or_expired_invitation');
  });

  it('accept requires a session → 401', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepting again when already a member is idempotent (consume + 200, no dup row)', async ({
    skip,
  }) => {
    if (!stores || !app || !email) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'idem-owner@test.com');
    // The invitee is already an admin member of the org.
    const invitee = await seedMemberOnOrg(stores.pool, owner.orgId, 'idem-invitee@test.com', 'member');

    // Owner can't invite an existing member via the route (409), so mint the invite directly.
    const { token } = await createInvitation(stores.pool, {
      orgId: owner.orgId,
      email: 'idem-invitee@test.com',
      role: 'admin',
      invitedBy: owner.userId,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { cookie: invitee.cookie },
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    // Still exactly one membership row, role UNCHANGED (the existing 'member', not the invite's 'admin').
    const m = await stores.pool.query<{ role: string }>(
      'SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2',
      [invitee.userId, owner.orgId],
    );
    expect(m.rowCount).toBe(1);
    expect(m.rows[0]?.role).toBe('member');
  });
});

describe('PATCH /v1/orgs/:id/members/:userId/role', () => {
  it('OWNER changes a member role', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'role-owner@test.com');
    const target = await seedMemberOnOrg(stores.pool, owner.orgId, 'role-target@test.com', 'member');

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${owner.orgId}/members/${target.userId}/role`,
      headers: { cookie: owner.cookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ role: string }>().role).toBe('admin');
    const m = await stores.pool.query<{ role: string }>(
      'SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2',
      [target.userId, owner.orgId],
    );
    expect(m.rows[0]?.role).toBe('admin');
  });

  it('demoting the LAST owner → 409 last_owner', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'lastowner-role@test.com');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${owner.orgId}/members/${owner.userId}/role`,
      headers: { cookie: owner.cookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('last_owner');
  });

  it('demoting an owner is fine when ANOTHER owner remains', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'two-owner-a@test.com');
    const owner2 = await seedMemberOnOrg(stores.pool, owner.orgId, 'two-owner-b@test.com', 'owner');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${owner.orgId}/members/${owner2.userId}/role`,
      headers: { cookie: owner.cookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('role change on a non-member → 404', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'role-404-owner@test.com');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${owner.orgId}/members/usr_does_not_exist/role`,
      headers: { cookie: owner.cookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a non-owner (admin) cannot change roles → 403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'role-403-owner@test.com');
    const admin = await seedMemberOnOrg(stores.pool, owner.orgId, 'role-403-admin@test.com', 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${owner.orgId}/members/${admin.userId}/role`,
      headers: { cookie: admin.cookie },
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /v1/orgs/:id/members/:userId', () => {
  it('OWNER removes a member → 204', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'del-owner@test.com');
    const target = await seedMemberOnOrg(stores.pool, owner.orgId, 'del-target@test.com', 'member');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.orgId}/members/${target.userId}`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(204);
    const m = await stores.pool.query(
      'SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2',
      [target.userId, owner.orgId],
    );
    expect(m.rowCount).toBe(0);
  });

  it('removing the LAST owner → 409 last_owner', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'del-lastowner@test.com');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.orgId}/members/${owner.userId}`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('last_owner');
  });

  it('removing a non-member → 404', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'del-404-owner@test.com');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.orgId}/members/usr_nope`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a non-owner (admin) cannot remove a member → 403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const owner = await seedUserOrgOwner(stores.pool, 'del-403-owner@test.com');
    const admin = await seedMemberOnOrg(stores.pool, owner.orgId, 'del-403-admin@test.com', 'admin');
    const target = await seedMemberOnOrg(stores.pool, owner.orgId, 'del-403-target@test.com', 'member');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.orgId}/members/${target.userId}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
