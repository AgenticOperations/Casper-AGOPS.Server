import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  sessionCookieFrom,
  type IdStores,
} from '../helpers/identity-harness.js';
import { hashApiKey } from '../../src/lib/ids.js';

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

async function registerAndCookie(email: string): Promise<string> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'hunter2-strong', name: 'D' },
  });
  return sessionCookieFrom(r.headers['set-cookie'])!;
}

describe('POST /v1/orgs', () => {
  it('an authenticated user creates an org, becomes owner, and gets the first sk_ ONCE', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const cookie = await registerAndCookie('founder@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'Acme Inc' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ org: { id: string; name: string }; role: string; api_key: string }>();
    expect(body.org.name).toBe('Acme Inc');
    expect(body.role).toBe('owner');
    expect(body.api_key.startsWith('sk_live_')).toBe(true); // raw key returned exactly once

    // The new sk_ key authenticates the existing control surface immediately.
    const summary = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${body.org.id}/summary`,
      headers: { authorization: `Bearer ${body.api_key}` },
    });
    expect(summary.statusCode).toBe(200);
  });

  it('makes the caller an OWNER member of the new org', async ({ skip }) => {
    if (!stores || !app) return skip();
    const cookie = await registerAndCookie('owner-check@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'OwnerCo' },
    });
    expect(res.statusCode).toBe(201);
    const orgId = res.json<{ org: { id: string } }>().org.id;
    const m = await stores.pool.query<{ role: string }>(
      `SELECT m.role FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND m.org_id = $2`,
      ['owner-check@test.com', orgId],
    );
    expect(m.rows[0]?.role).toBe('owner');
  });

  it('stores ONE logical key: api_keys.key_hash == orgs.admin_key_hash == sha256(raw)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const cookie = await registerAndCookie('onekey@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'OneKeyCo' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ org: { id: string }; api_key: string }>();
    const expectedHash = hashApiKey(body.api_key);

    const org = await stores.pool.query<{ admin_key_hash: string }>(
      'SELECT admin_key_hash FROM orgs WHERE id = $1',
      [body.org.id],
    );
    expect(org.rows[0]?.admin_key_hash).toBe(expectedHash);

    const keys = await stores.pool.query<{ key_hash: string; created_by: string; label: string }>(
      'SELECT key_hash, created_by, label FROM api_keys WHERE org_id = $1',
      [body.org.id],
    );
    // Exactly one api_keys row for the new org, with the SAME hash (single logical key).
    expect(keys.rowCount).toBe(1);
    expect(keys.rows[0]?.key_hash).toBe(expectedHash);
    expect(keys.rows[0]?.created_by).not.toBeNull();
    expect(keys.rows[0]?.label).toBe('default');
  });

  it('rejects org creation without a session (401)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({ method: 'POST', url: '/v1/orgs', payload: { name: 'NoAuth' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty/invalid org name with 400', async ({ skip }) => {
    if (!stores || !app) return skip();
    const cookie = await registerAndCookie('badname@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/me', () => {
  it('returns the current user + their memberships/orgs', async ({ skip }) => {
    if (!stores || !app) return skip();
    const cookie = await registerAndCookie('me@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'MyOrg' },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      user: { email: string; email_verified: boolean };
      orgs: Array<{ org_id: string; role: string; name: string }>;
    }>();
    expect(body.user.email).toBe('me@test.com');
    expect(body.user.email_verified).toBe(false);
    expect(body.orgs.some((o) => o.role === 'owner' && o.name === 'MyOrg')).toBe(true);
  });

  it('returns an empty orgs array for a user with no memberships', async ({ skip }) => {
    if (!stores || !app) return skip();
    const cookie = await registerAndCookie('lonely@test.com');
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ user: { email: string }; orgs: unknown[] }>();
    expect(body.user.email).toBe('lonely@test.com');
    expect(body.orgs).toEqual([]);
  });

  it('401 without a session', async ({ skip }) => {
    if (!stores || !app) return skip();
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });
});
