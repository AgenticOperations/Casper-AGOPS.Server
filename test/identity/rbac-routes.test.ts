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

describe('RBAC on the control surface (session cookie path)', () => {
  it('an owner cookie can read GET /v1/orgs/:id/summary', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, cookie } = await seedUserOrgOwner(stores.pool, 'owner@rbac.com');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/summary`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a member cookie CANNOT POST the kill-switch (needs admin+) → 403', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId } = await seedUserOrgOwner(stores.pool, 'admin-seed@rbac.com');
    const member = await createUser(stores.pool, {
      email: 'member@rbac.com',
      passwordHash: 'scrypt$x',
      emailVerified: true,
    });
    await addMembership(stores.pool, { userId: member.id, orgId, role: 'member' });
    const { token } = await createSession(stores.pool, member.id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/kill-switch',
      headers: { cookie: `agentops_session=${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('a member cookie CAN read monitoring decisions (read = member+)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId } = await seedUserOrgOwner(stores.pool, 'admin-seed2@rbac.com');
    const member = await createUser(stores.pool, {
      email: 'member2@rbac.com',
      passwordHash: 'scrypt$x',
      emailVerified: true,
    });
    await addMembership(stores.pool, { userId: member.id, orgId, role: 'member' });
    const { token } = await createSession(stores.pool, member.id);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions',
      headers: { cookie: `agentops_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
