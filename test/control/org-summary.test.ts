import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createOrg } from '../../src/engines/control/store.js';
import { setOrgKillSwitch } from '../../src/engines/control/kill-switch.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { keys } from '../../src/redis/keyspace.js';
import {
  startStores,
  stopStores,
  buildOracleApp,
  usdc,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * Group A control read (doc 05 §9): the org summary the console shell loads on entry — org header,
 * DENY_ALL state, committed-budget total. Admin-key authed (sk_live_), tenant-fenced (the path :id must
 * match the org the key owns), money as base-units string (never a float). Off the hot path. Requires
 * Docker; skips when none is available.
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

async function seedOrgAdmin(name = 'Acme'): Promise<{ orgId: string; sk: string }> {
  const key = issueAdminKey();
  const org = await createOrg(stores!.pool, { name, adminKeyHash: key.hash });
  return { orgId: org.id, sk: key.token };
}

describe('GET /v1/orgs/:id/summary', () => {
  it('requires the sk_ admin key', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId } = await seedOrgAdmin();
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/summary` });
    expect(res.statusCode).toBe(401);
  });

  it('returns org header + deny_all + committed totals for the owning org', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, sk } = await seedOrgAdmin('Globex');
    await stores.redis.set(keys.allocationCommitted(orgId), usdc(200).toString());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/summary`,
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      org: { id: string; name: string };
      deny_all: boolean;
      totals: { allocation_committed: string; policy_epoch: number };
    }>();
    expect(body.org).toEqual({ id: orgId, name: 'Globex' });
    expect(body.deny_all).toBe(false);
    expect(body.totals.allocation_committed).toBe('200000000');
    expect(body.totals.policy_epoch).toBe(0);
  });

  it('reflects the DENY_ALL state after a kill-switch', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, sk } = await seedOrgAdmin();
    await setOrgKillSwitch(stores.redis, orgId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/summary`,
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(res.json<{ deny_all: boolean }>().deny_all).toBe(true);
  });

  it('is tenant-fenced: another org id under this key is 404', async ({ skip }) => {
    if (!stores || !app) return skip();
    const a = await seedOrgAdmin('A');
    const b = await seedOrgAdmin('B');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${b.orgId}/summary`,
      headers: { authorization: `Bearer ${a.sk}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
