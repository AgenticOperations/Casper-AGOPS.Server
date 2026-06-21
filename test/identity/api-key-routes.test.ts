import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  seedUserOrgOwner,
  type IdStores,
} from '../helpers/identity-harness.js';
import { createUser } from '../../src/engines/identity/account/user-store.js';
import { createSession } from '../../src/engines/identity/account/session-store.js';
import { addMembership } from '../../src/engines/identity/access/membership-store.js';

let stores: IdStores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startIdStores();
  if (stores) app = buildIdApp(stores.pool, stores.redis).app;
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stopIdStores(stores);
});

describe('API-key management', () => {
  it('POST issues a key (raw returned ONCE), GET lists it masked (no raw)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, cookie } = await seedUserOrgOwner(stores.pool, 'keys-owner@test.com');
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie },
      payload: { label: 'ci' },
    });
    expect(issued.statusCode).toBe(201);
    const ibody = issued.json<{ api_key: string; key: { id: string; label: string } }>();
    expect(ibody.api_key.startsWith('sk_live_')).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const lbody = list.json<{
      keys: Array<{ id: string; label: string; prefix: string; masked: string; revoked: boolean }>;
    }>();
    const row = lbody.keys.find((k) => k.id === ibody.key.id)!;
    expect(row.label).toBe('ci');
    expect(row.masked).toMatch(/^sk_live_•+$/); // masked, never the raw key
    expect(JSON.stringify(lbody)).not.toContain(ibody.api_key); // raw never reappears

    // The issued key appears in the listing (active, not revoked).
    expect(row.revoked).toBe(false);
    // No row leaks a hash or the raw key field.
    for (const k of lbody.keys) {
      expect(k).not.toHaveProperty('key_hash');
      expect(k).not.toHaveProperty('hash');
      expect(k).not.toHaveProperty('api_key');
    }
  });

  it('the issued key immediately authenticates an admin/read route', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, cookie } = await seedUserOrgOwner(stores.pool, 'keys-auth@test.com');
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie },
      payload: { label: 'fresh' },
    });
    const ibody = issued.json<{ api_key: string }>();
    const summary = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/summary`,
      headers: { authorization: `Bearer ${ibody.api_key}` },
    });
    expect(summary.statusCode).toBe(200);
  });

  it('DELETE revokes a key (it stops authenticating)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, cookie } = await seedUserOrgOwner(stores.pool, 'keys-revoke@test.com');
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie },
      payload: { label: 'temp' },
    });
    const ibody = issued.json<{ api_key: string; key: { id: string } }>();

    // It works before revoke.
    const before = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/summary`,
      headers: { authorization: `Bearer ${ibody.api_key}` },
    });
    expect(before.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${orgId}/api-keys/${ibody.key.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/summary`,
      headers: { authorization: `Bearer ${ibody.api_key}` },
    });
    expect(after.statusCode).toBe(401); // revoked key no longer resolves

    // Idempotency: revoking an already-revoked key is a no-op 404 (the live-row UPDATE matched nothing).
    const delAgain = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${orgId}/api-keys/${ibody.key.id}`,
      headers: { cookie },
    });
    expect(delAgain.statusCode).toBe(404);

    // The revoked key still appears in the list, flagged revoked.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie },
    });
    const row = list
      .json<{ keys: Array<{ id: string; revoked: boolean }> }>()
      .keys.find((k) => k.id === ibody.key.id)!;
    expect(row.revoked).toBe(true);
  });

  it('a member (read-only) CANNOT issue/list/revoke a key → 403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId } = await seedUserOrgOwner(stores.pool, 'km-owner@test.com');
    const m = await createUser(stores.pool, {
      email: 'km-member@test.com',
      passwordHash: 'scrypt$x',
      emailVerified: true,
    });
    await addMembership(stores.pool, { userId: m.id, orgId, role: 'member' });
    const { token } = await createSession(stores.pool, m.id);
    const memberCookie = `agentops_session=${token}`;

    const issue = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    expect(issue.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/api-keys`,
      headers: { cookie: memberCookie },
    });
    expect(list.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${orgId}/api-keys/some-key-id`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it('no session/key → 401', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId } = await seedUserOrgOwner(stores.pool, 'km-anon@test.com');
    const issue = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/api-keys`,
      payload: {},
    });
    expect(issue.statusCode).toBe(401);
    const list = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/api-keys` });
    expect(list.statusCode).toBe(401);
  });

  it('another org cannot list/revoke this org keys (tenant fence) → 404/403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const a = await seedUserOrgOwner(stores.pool, 'fence-a@test.com');
    const b = await seedUserOrgOwner(stores.pool, 'fence-b@test.com');

    // Issue a real key in org A so we have a concrete keyId to attempt to revoke cross-tenant.
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${a.orgId}/api-keys`,
      headers: { cookie: a.cookie },
      payload: { label: 'a-only' },
    });
    const aKey = issued.json<{ api_key: string; key: { id: string } }>();

    // B (a different org's owner) cannot list A's keys.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${a.orgId}/api-keys`,
      headers: { cookie: b.cookie },
    });
    expect([403, 404]).toContain(list.statusCode);

    // B cannot revoke A's key.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${a.orgId}/api-keys/${aKey.key.id}`,
      headers: { cookie: b.cookie },
    });
    expect([403, 404]).toContain(del.statusCode);

    // A's key still authenticates — the cross-tenant probe revoked nothing.
    const stillWorks = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${a.orgId}/summary`,
      headers: { authorization: `Bearer ${aKey.api_key}` },
    });
    expect(stillWorks.statusCode).toBe(200);
  });
});
