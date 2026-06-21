import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createOrg } from '../../src/engines/control/store.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { emitDecisionSafe } from '../../src/engines/monitoring/telemetry.js';
import {
  startStores,
  stopStores,
  buildOracleApp,
  seedAgent,
  raw402,
  requestContext,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * E8 monitoring HTTP surface (engine-specs-FINAL.md:256,258): the read-side decision feed + SSE, and the
 * P1-actuated Tier-3 (org DENY_ALL) / Tier-2 (per-agent suspend) control routes. All org-scoped via the
 * `sk_live_` admin key (org isolation, :268); none sits on the agent hot path. Requires Docker; skips
 * when none is available.
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

/** Seed an org with an admin key we control, returning the sk_ token (no agent needed). */
async function seedOrgAdmin(): Promise<{ orgId: string; sk: string }> {
  const key = issueAdminKey();
  const org = await createOrg(stores!.pool, { name: 'Mon', adminKeyHash: key.hash });
  return { orgId: org.id, sk: key.token };
}

describe('E8 read-side feed (engine-specs-FINAL.md:258)', () => {
  it('GET /v1/monitoring/decisions requires the sk_ admin key and returns the redacted feed', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { orgId, sk } = await seedOrgAdmin();
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_r1',
      agentId: 'agt_r1',
      orgId,
      outcome: 'ALLOW',
      railScheme: 'raw-x402',
      railChain: 'arc',
      resourceId: 'svc:weather',
      amount: '5000000',
      ts: 1,
    });

    expect((await app.inject({ method: 'GET', url: '/v1/monitoring/decisions' })).statusCode).toBe(401);

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions?limit=10',
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ decisions: Array<{ paymentId: string; outcome: string }> }>();
    expect(body.decisions[0]?.paymentId).toBe('pay_r1');
    expect(body.decisions[0]?.outcome).toBe('ALLOW');
    expect(ok.body).not.toMatch(/signature|x_payment/i);
  });

  it('SSE returns a bounded text/event-stream snapshot of the feed (admin-authed)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, sk } = await seedOrgAdmin();
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_s1',
      agentId: 'agt_s1',
      orgId,
      outcome: 'DENY',
      reason: 'spend_cap_exceeded',
      railScheme: 'raw-x402',
      railChain: 'arc',
      resourceId: 'svc:weather',
      amount: '5000000',
      ts: 1,
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/monitoring/decisions/stream' })).statusCode,
    ).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions/stream',
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.body).toContain('data:');
    expect(res.body).toContain('pay_s1');
    expect(res.body).not.toMatch(/signature|x_payment/i);
  });

  it('an ALLOW authorize emits a redacted C-10 copy to the org feed (fire-and-forget end-to-end)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 10);

    const allow = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(allow.statusCode).toBe(200);
    const paymentId = allow.json<{ payment_id: string }>().payment_id;

    // The emit is fire-and-forget, so poll the feed until the copy lands (bounded).
    let found: { paymentId: string; outcome: string } | undefined;
    for (let i = 0; i < 50 && !found; i += 1) {
      const feed = await app.inject({
        method: 'GET',
        url: '/v1/monitoring/decisions?limit=50',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      found = feed
        .json<{ decisions: Array<{ paymentId: string; outcome: string }> }>()
        .decisions.find((d) => d.paymentId === paymentId);
      if (!found) await new Promise((r) => setTimeout(r, 20));
    }
    expect(found?.outcome).toBe('ALLOW');
  });
});

describe('E8 P1-actuated control routes (engine-specs-FINAL.md:256, BUG-15)', () => {
  it('POST/DELETE /v1/admin/kill-switch is auth-fenced and drives the authorize path end-to-end', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const authorize = () =>
      app!.inject({
        method: 'POST',
        url: '/v1/payment/authorize',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
      });

    // Auth fence: no bearer and an ag_ bearer are both refused — only the operator sk_ may actuate.
    expect((await app.inject({ method: 'POST', url: '/v1/admin/kill-switch' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/kill-switch',
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).statusCode,
    ).toBe(401);

    expect((await authorize()).statusCode).toBe(200); // baseline ALLOW

    const set = await app.inject({
      method: 'POST',
      url: '/v1/admin/kill-switch',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ org_suspended: boolean }>().org_suspended).toBe(true);
    const denied = await authorize();
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('org_suspended');

    const clear = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/kill-switch',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(clear.statusCode).toBe(200);
    expect((await authorize()).statusCode).toBe(200); // restored
  });

  it('POST /v1/admin/agents/:id/suspend (Tier-2) is tenant-fenced; unknown id → 404', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const hit = await app.inject({
      method: 'POST',
      url: `/v1/admin/agents/${agentId}/suspend`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(hit.statusCode).toBe(200);
    const miss = await app.inject({
      method: 'POST',
      url: '/v1/admin/agents/agt_nope/suspend',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(miss.statusCode).toBe(404);
  });
});
