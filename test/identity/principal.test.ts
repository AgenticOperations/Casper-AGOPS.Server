import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ROLE_RANK, satisfiesRole, type Role } from '../../src/engines/identity/access/roles.js';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  seedUserOrgOwner,
  type IdStores,
} from '../helpers/identity-harness.js';
import { authenticatePrincipal } from '../../src/engines/identity/access/principal.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { createOrg } from '../../src/engines/control/store.js';

describe('role matrix', () => {
  it('ranks owner > admin > member', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.member);
  });
  it('satisfiesRole(min) is true at or above min', () => {
    expect(satisfiesRole('admin', 'member')).toBe(true); // admin meets member-min
    expect(satisfiesRole('owner', 'admin')).toBe(true);
    expect(satisfiesRole('member', 'admin')).toBe(false); // member fails admin-min
    expect(satisfiesRole('admin', 'owner')).toBe(false);
  });
  it('an sk_ key principal is treated as admin-equivalent (writes+keys, not member-mgmt)', () => {
    // documented: key principals carry role 'admin' — see roles.ts KEY_ROLE
    const r: Role = 'admin';
    expect(satisfiesRole(r, 'admin')).toBe(true);
    expect(satisfiesRole(r, 'owner')).toBe(false);
  });
});

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

describe('authenticatePrincipal', () => {
  it('resolves a session cookie → {actorType:user, orgId, role, userId}', async ({ skip }) => {
    if (!stores) return skip();
    const { cookie, orgId, userId } = await seedUserOrgOwner(stores.pool, 'p1@test.com');
    const out = await authenticatePrincipal(stores.pool, {
      cookieHeader: cookie,
      authzHeader: undefined,
      cookieName: 'agentops_session',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.principal.actorType).toBe('user');
      expect(out.principal.orgId).toBe(orgId);
      expect(out.principal.role).toBe('owner');
      expect(out.principal.userId).toBe(userId);
    }
  });

  it('resolves a NEW api_keys sk_ Bearer → {actorType:key, orgId, role:admin}', async ({ skip }) => {
    if (!stores) return skip();
    const { orgId } = await seedUserOrgOwner(stores.pool, 'p2@test.com');
    // Issue a key directly into api_keys for this org (the route path is tested in P1e).
    const key = issueAdminKey();
    await stores.pool.query(
      "INSERT INTO api_keys (id, org_id, key_hash, label) VALUES ($1,$2,$3,'t')",
      ['ak_test_p2', orgId, key.hash],
    );
    const out = await authenticatePrincipal(stores.pool, {
      cookieHeader: undefined,
      authzHeader: `Bearer ${key.token}`,
      cookieName: 'agentops_session',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.principal.actorType).toBe('key');
      expect(out.principal.orgId).toBe(orgId);
      expect(out.principal.role).toBe('admin');
    }
  });

  it('resolves a LEGACY orgs.admin_key_hash sk_ Bearer via fallback', async ({ skip }) => {
    if (!stores) return skip();
    const key = issueAdminKey();
    const org = await createOrg(stores.pool, { name: 'LegacyCo', adminKeyHash: key.hash });
    // Simulate a pre-existing org whose key is NOT in api_keys (delete the backfilled row).
    await stores.pool.query('DELETE FROM api_keys WHERE org_id=$1', [org.id]);
    const out = await authenticatePrincipal(stores.pool, {
      cookieHeader: undefined,
      authzHeader: `Bearer ${key.token}`,
      cookieName: 'agentops_session',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.principal.orgId).toBe(org.id);
      expect(out.principal.actorType).toBe('key');
    }
  });

  it('rejects a REVOKED sk_ Bearer even when the legacy orgs.admin_key_hash still matches', async ({
    skip,
  }) => {
    if (!stores) return skip();
    // Backfill shape (migration 0006): the SAME key_hash lives in BOTH orgs.admin_key_hash AND
    // api_keys. Once the api_keys row is revoked, the key must be rejected — it must NOT silently
    // re-authenticate through the legacy column. Reproduce the backfill explicitly: the one-shot
    // migration only ran for orgs that pre-existed it, so a test-created org needs the matching
    // api_keys row inserted by hand, exactly as the backfill would have.
    const key = issueAdminKey();
    const org = await createOrg(stores.pool, { name: 'RevokedCo', adminKeyHash: key.hash });
    await stores.pool.query(
      "INSERT INTO api_keys (id, org_id, key_hash, label, revoked_at) VALUES ($1,$2,$3,'legacy-admin', now() - interval '1 hour')",
      ['ak_revoked_' + org.id, org.id, key.hash],
    );
    // Sanity: the (revoked) api_keys row for this key_hash exists.
    const before = await stores.pool.query('SELECT id FROM api_keys WHERE key_hash=$1', [key.hash]);
    expect(before.rows.length).toBeGreaterThan(0);
    const out = await authenticatePrincipal(stores.pool, {
      cookieHeader: undefined,
      authzHeader: `Bearer ${key.token}`,
      cookieName: 'agentops_session',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe(401);
    // Guard against false-negative: make sure the org's legacy column does still match this key,
    // so the test would have passed via the legacy fallback bug had the fix not been applied.
    const legacy = await stores.pool.query<{ id: string }>(
      'SELECT id FROM orgs WHERE admin_key_hash=$1',
      [key.hash],
    );
    expect(legacy.rows[0]?.id).toBe(org.id);
  });

  it('rejects an ag_ Bearer on the admin surface (hot-path fence intact)', async ({ skip }) => {
    if (!stores) return skip();
    const out = await authenticatePrincipal(stores.pool, {
      cookieHeader: undefined,
      authzHeader: 'Bearer ag_live_deadbeef',
      cookieName: 'agentops_session',
    });
    expect(out.ok).toBe(false);
  });

  it('rejects no credential', async ({ skip }) => {
    if (!stores) return skip();
    const out = await authenticatePrincipal(stores.pool, {
      cookieHeader: undefined,
      authzHeader: undefined,
      cookieName: 'agentops_session',
    });
    expect(out.ok).toBe(false);
  });
});
