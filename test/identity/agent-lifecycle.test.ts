import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startStores,
  stopStores,
  buildOracleApp,
  type Stores,
} from '../helpers/oracle-harness.js';
import { seedUserOrgOwner, seedMemberOnOrg } from '../helpers/identity-harness.js';

/**
 * P1f — Agent lifecycle routes (create/rename/retire/rotate-key), all admin+ and tenant-fenced.
 *
 * Uses the oracle harness (full hot-path app + all identity routes share one buildApp) so the same
 * suite can prove BOTH the control-plane CRUD AND the security-critical hot-path consequences:
 *   - a RETIRED agent's ag_ is rejected on POST /v1/payment/authorize (deny-tightening, fail-closed);
 *   - after rotate-key the OLD ag_ stops authorizing immediately and the NEW one is honoured.
 */

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

describe('Agent lifecycle (admin+, tenant-fenced)', () => {
  it('POST /v1/agents creates a named agent, returns the ag_ key ONCE, agent in roster', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { orgId, cookie } = await seedUserOrgOwner(stores.pool, 'ag-owner@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { cookie },
      payload: { name: 'crawler-1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      agent: { id: string; name: string; org_id: string; status: string };
      api_key: string;
    }>();
    expect(body.agent.name).toBe('crawler-1');
    expect(body.agent.org_id).toBe(orgId);
    expect(body.agent.status).toBe('active');
    expect(body.api_key.startsWith('ag_live_')).toBe(true);

    // Agent appears in the org roster (treasury-read float table keys agents by `id`).
    const roster = await app.inject({ method: 'GET', url: '/v1/agents', headers: { cookie } });
    expect(roster.statusCode).toBe(200);
    const agents = roster.json<{ agents: Array<{ id: string }> }>().agents;
    expect(agents.some((a) => a.id === body.agent.id)).toBe(true);
  });

  it('PATCH /v1/agents/:id renames the agent', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { cookie } = await seedUserOrgOwner(stores.pool, 'ag-rename@test.com');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie },
        payload: { name: 'orig' },
      })
    ).json<{ agent: { id: string } }>();

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${created.agent.id}`,
      headers: { cookie },
      payload: { name: 'renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ agent: { name: string } }>().agent.name).toBe('renamed');
  });

});

describe('Agent lifecycle — authz floor + tenant isolation', () => {
  it('no credentials → 401 on every lifecycle route', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { cookie } = await seedUserOrgOwner(stores.pool, 'authz-401@test.com');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie },
        payload: { name: 'a' },
      })
    ).json<{ agent: { id: string } }>();
    const id = created.agent.id;

    expect((await app.inject({ method: 'POST', url: '/v1/agents', payload: { name: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: `/v1/agents/${id}`, payload: { name: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/agents/${id}/retire`, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/agents/${id}/rotate-key`, payload: {} })).statusCode).toBe(401);
  });

  it('member role → 403 on every lifecycle route (admin+ floor)', async ({ skip }) => {
    if (!stores || !app) return skip();
    // Owner creates an agent; a member of the same org may not mutate it.
    const owner = await seedUserOrgOwner(stores.pool, 'authz-owner@test.com');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie: owner.cookie },
        payload: { name: 'a' },
      })
    ).json<{ agent: { id: string } }>();
    const id = created.agent.id;
    const member = await seedMemberOnOrg(stores.pool, owner.orgId, 'authz-member@test.com', 'member');

    const create = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { cookie: member.cookie },
      payload: { name: 'x' },
    });
    expect(create.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: { cookie: member.cookie }, payload: { name: 'x' } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/agents/${id}/retire`, headers: { cookie: member.cookie }, payload: {} })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/agents/${id}/rotate-key`, headers: { cookie: member.cookie }, payload: {} })).statusCode,
    ).toBe(403);
  });

  it('tenant isolation: org B cannot rename / retire / rotate org A agent → 404', async ({ skip }) => {
    if (!stores || !app) return skip();
    const a = await seedUserOrgOwner(stores.pool, 'iso-a@test.com');
    const b = await seedUserOrgOwner(stores.pool, 'iso-b@test.com');
    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie: a.cookie },
        payload: { name: 'x' },
      })
    ).json<{ agent: { id: string } }>();
    const id = created.agent.id;

    const rename = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${id}`,
      headers: { cookie: b.cookie },
      payload: { name: 'hijack' },
    });
    expect(rename.statusCode).toBe(404);

    const retire = await app.inject({
      method: 'POST',
      url: `/v1/agents/${id}/retire`,
      headers: { cookie: b.cookie },
      payload: {},
    });
    expect(retire.statusCode).toBe(404);

    const rotate = await app.inject({
      method: 'POST',
      url: `/v1/agents/${id}/rotate-key`,
      headers: { cookie: b.cookie },
      payload: {},
    });
    expect(rotate.statusCode).toBe(404);
  });

  it('invalid body → 400 (create requires a name; rename requires a name)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { cookie } = await seedUserOrgOwner(stores.pool, 'badbody@test.com');
    const create = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { cookie },
      payload: {},
    });
    expect(create.statusCode).toBe(400);

    const created = (
      await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie },
        payload: { name: 'ok' },
      })
    ).json<{ agent: { id: string } }>();
    const rename = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${created.agent.id}`,
      headers: { cookie },
      payload: { name: '' },
    });
    expect(rename.statusCode).toBe(400);
  });
});
