import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  startIdStores,
  stopIdStores,
  buildIdApp,
  type IdStores,
} from '../helpers/identity-harness.js';
import { createUser } from '../../src/engines/identity/account/user-store.js';
import { createSession } from '../../src/engines/identity/account/session-store.js';
import { createOrg, registerAgent } from '../../src/engines/control/store.js';
import { addMembership } from '../../src/engines/identity/access/membership-store.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { ORG_SELECTION_HEADER } from '../../src/engines/identity/access/route-guard.js';

/**
 * Org SELECTION via header (not the path tenant-fence). A human who belongs to >1 org picks the active
 * org on NON-path-scoped console reads (e.g. GET /v1/agents) with the `X-AgentOps-Org` header. Without
 * the header the principal defaults to the first membership (backward-compatible). Selecting an org the
 * user is NOT a member of is 403 (no resource leak). An sk_ key resolves to its own org regardless of
 * the header (a key is bound to exactly one org). Requires Docker; skips when none available.
 */
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

/** A user who owns org A (created first → default) and admins org B (one agent). */
async function seedTwoOrgUser(email: string) {
  const pool = stores!.pool;
  const user = await createUser(pool, {
    email,
    passwordHash: 'scrypt$x',
    emailVerified: true,
    name: 'Multi',
  });
  const orgA = await createOrg(pool, { name: 'OrgA', adminKeyHash: issueAdminKey().hash });
  await addMembership(pool, { userId: user.id, orgId: orgA.id, role: 'owner' });
  const orgB = await createOrg(pool, { name: 'OrgB', adminKeyHash: issueAdminKey().hash });
  await addMembership(pool, { userId: user.id, orgId: orgB.id, role: 'admin' });
  // One agent in B only; A has zero — so the resolved org is provable from the agent count.
  await registerAgent(pool, { orgId: orgB.id, name: 'b-agent' });
  const { token } = await createSession(pool, user.id);
  return { cookie: `agentops_session=${token}`, orgA: orgA.id, orgB: orgB.id };
}

describe('org selection header on non-path-scoped control reads', () => {
  it('defaults to the first membership when no header is sent (org A, zero agents)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { cookie } = await seedTwoOrgUser('orgsel-default@test.com');
    const res = await app.inject({ method: 'GET', url: '/v1/agents', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ agents: unknown[] }>().agents).toHaveLength(0);
  });

  it('selects org B when X-AgentOps-Org names it (one agent)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { cookie, orgB } = await seedTwoOrgUser('orgsel-pick@test.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { cookie, [ORG_SELECTION_HEADER]: orgB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ agents: unknown[] }>().agents).toHaveLength(1);
  });

  it('rejects selecting an org the user is not a member of (403, no leak)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { cookie } = await seedTwoOrgUser('orgsel-foreign@test.com');
    const foreign = await createOrg(stores.pool, {
      name: 'Foreign',
      adminKeyHash: issueAdminKey().hash,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { cookie, [ORG_SELECTION_HEADER]: foreign.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ignores the header for an sk_ key — a key is bound to its own org', async ({ skip }) => {
    if (!stores || !app) return skip();
    // Key owns org B (one agent). A mismatched header naming org A must NOT redirect or fence the key.
    const { orgB, orgA } = await seedTwoOrgUser('orgsel-key@test.com');
    const key = issueAdminKey();
    await stores.pool.query(
      "INSERT INTO api_keys (id, org_id, key_hash, label) VALUES ($1,$2,$3,'sel')",
      ['ak_sel_' + orgB, orgB, key.hash],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${key.token}`, [ORG_SELECTION_HEADER]: orgA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ agents: unknown[] }>().agents).toHaveLength(1); // org B's agent, header ignored
  });
});
