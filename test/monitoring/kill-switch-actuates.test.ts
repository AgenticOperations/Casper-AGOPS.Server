import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setOrgKillSwitch,
  clearOrgKillSwitch,
  isOrgSuspended,
  suspendAgent,
  reinstateAgent,
} from '../../src/engines/control/kill-switch.js';
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
 * The graded-response actuators (engine-specs-FINAL.md:80,256, BUG-15). The READ gates already exist —
 * enforce.ts:113 (P3-A) and allocation-eval.ts:64 (P3-B) test `denyAll`; auth.ts:56 refuses a suspended
 * agent. These tests prove the set/clear half DRIVES those existing gates end-to-end (no new gate is
 * introduced). Requires Docker; skips when none is available.
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

const authorize = (apiKey: string, agentId: string) =>
  app!.inject({
    method: 'POST',
    url: '/v1/payment/authorize',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
  });

describe('Tier-3 org kill-switch actuator drives the existing gate (engine-specs-FINAL.md:80,128,256)', () => {
  it('set → a previously-ALLOWED spend DENYs org_suspended; clear → ALLOW again', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    expect((await authorize(apiKey, agentId)).statusCode).toBe(200); // baseline ALLOW

    await setOrgKillSwitch(stores.redis, orgId);
    expect(await isOrgSuspended(stores.redis, orgId)).toBe(true);
    const denied = await authorize(apiKey, agentId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('org_suspended');

    await clearOrgKillSwitch(stores.redis, orgId);
    expect(await isOrgSuspended(stores.redis, orgId)).toBe(false);
    expect((await authorize(apiKey, agentId)).statusCode).toBe(200); // restored
  });
});

describe('Tier-2 per-agent suspend actuator (engine-specs-FINAL.md:256; auth.ts gate)', () => {
  it('suspend → 403 agent_suspended; reinstate → ALLOW; tenant-fenced + unknown=false', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { orgId, agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    expect(await suspendAgent(stores.pool, { agentId, orgId })).toBe(true);
    const denied = await authorize(apiKey, agentId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('agent_suspended');

    expect(await reinstateAgent(stores.pool, { agentId, orgId })).toBe(true);
    expect((await authorize(apiKey, agentId)).statusCode).toBe(200);

    // Cross-tenant / unknown id changes nothing (org isolation, engine-specs-FINAL.md:268).
    expect(await suspendAgent(stores.pool, { agentId, orgId: 'org_other' })).toBe(false);
    expect(await suspendAgent(stores.pool, { agentId: 'agt_nope', orgId })).toBe(false);
  });
});
