import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { setupDemoAgent, resetDemo } from '../../src/engines/demo/provision.js';
import { authenticateAdmin } from '../../src/engines/control/admin-auth.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('demo provision (Docker-gated)', () => {
  it('bootstraps the operator org from an unseen sk_ and registers a $10-cap agent', async (ctx) => {
    if (!stores) return ctx.skip();
    const sk = issueAdminKey().token; // an sk_ that resolves to no org yet
    const out = await setupDemoAgent(stores.pool, stores.redis, { adminKey: sk, capUsdc: 10 });
    expect(out.agent_id).toMatch(/^agt_/);
    expect(out.agent_key).toMatch(/^ag_live_/);
    expect(out.spend_cap).toBe('10000000'); // $10 in base units
    // the same sk now authenticates to the bootstrapped org
    const admin = await authenticateAdmin(stores.pool, `Bearer ${sk}`);
    expect(admin.ok).toBe(true);
    if (admin.ok) expect(admin.orgId).toBe(out.org_id);
  });

  it('is idempotent on the org: a second setup with the same sk_ reuses the org, new agent', async (ctx) => {
    if (!stores) return ctx.skip();
    const sk = issueAdminKey().token;
    const a = await setupDemoAgent(stores.pool, stores.redis, { adminKey: sk, capUsdc: 10 });
    const b = await setupDemoAgent(stores.pool, stores.redis, { adminKey: sk, capUsdc: 10 });
    expect(b.org_id).toBe(a.org_id);
    expect(b.agent_id).not.toBe(a.agent_id);
  });

  it('resetDemo suspends demo agents and lifts deny_all', async (ctx) => {
    if (!stores) return ctx.skip();
    const sk = issueAdminKey().token;
    const out = await setupDemoAgent(stores.pool, stores.redis, { adminKey: sk, capUsdc: 10 });
    await stores.redis.set(`org:${out.org_id}:deny_all`, '1');
    await resetDemo(stores.pool, stores.redis, { orgId: out.org_id });
    expect(await stores.redis.exists(`org:${out.org_id}:deny_all`)).toBe(0);
    const { rows } = await stores.pool.query<{ status: string }>(
      'SELECT status FROM agents WHERE id = $1', [out.agent_id],
    );
    expect(rows[0]?.status).toBe('suspended');
  });
});
