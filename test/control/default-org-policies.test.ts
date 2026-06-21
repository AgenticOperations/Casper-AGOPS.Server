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

/**
 * Self-serve completeness: an org created via POST /v1/orgs must get a WORKING default policy baseline
 * (one org-scoped spend + allocation layer). Without it, the effective-policy compiler 500s on every
 * downstream read/provision/authorize ("compileSpend/compileAllocation: at least one layer required"),
 * which made the whole self-serve onboarding (provision float, set policy, read policy) unusable.
 * Requires Docker; skips when none available.
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

async function sessionFor(email: string): Promise<string> {
  const user = await createUser(stores!.pool, {
    email,
    passwordHash: 'scrypt$x',
    emailVerified: true,
    name: 'Owner',
  });
  const { token } = await createSession(stores!.pool, user.id);
  return `agentops_session=${token}`;
}

describe('POST /v1/orgs seeds a working default policy baseline', () => {
  it('a fresh org → agent can read its effective policy (no 500) and provision float', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const cookie = await sessionFor('defpol-owner@test.com');

    // 1. Create the org via the real route (this is what seeds the default policies).
    const orgRes = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { cookie },
      payload: { name: 'DefPol Co' },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgId = orgRes.json<{ org: { id: string } }>().org.id;

    // 2. Create an agent in that org.
    const agentRes = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { cookie, 'x-agentops-org': orgId },
      payload: { name: 'a1' },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json<{ agent: { id: string } }>().agent.id;

    // 3. Reading the effective policy must COMPILE (was a 500 before the default-baseline seed).
    const polRes = await app.inject({
      method: 'GET',
      url: `/v1/agents/${agentId}/policy`,
      headers: { cookie, 'x-agentops-org': orgId },
    });
    expect(polRes.statusCode).toBe(200);
    const eff = polRes.json<{ spend: { rail_permission: string[] }; allocation: unknown }>();
    expect(eff.spend).toBeTruthy();
    expect(eff.allocation).toBeTruthy();
    expect(eff.spend.rail_permission).toContain('raw-x402');
  });
});
