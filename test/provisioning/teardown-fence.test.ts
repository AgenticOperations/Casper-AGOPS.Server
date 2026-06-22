import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GatewayClient, type GatewayTransport } from '../../src/lib/circle/gateway.js';
import { type ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { teardownAgent } from '../../src/engines/provisioning/teardown.js';
import { authenticateAgent } from '../../src/engines/oracle/auth.js';
import { keys } from '../../src/redis/keyspace.js';
import { startStores, stopStores, seedAgent, usdc, type Stores } from '../helpers/oracle-harness.js';

/**
 * Teardown reclaim-fence (M8). M6 left a race: a spend could hit the agent's `float_confirmed` WHILE
 * teardown reclaimed it. M8 closes the NEW-spend arm by suspending the agent BEFORE the sweep + reclaim,
 * so a fresh authorize is DENIED (agent_suspended, auth.ts:56) and never reaches signing. We prove the
 * ORDERING — the agent is already 'suspended' at the moment reclaim is called — and that the fence
 * persists after teardown. (Draining a spend already in-flight past the auth gate against this reclaim
 * stays SPIKE-03 / M9.) Requires Docker; skips when none is available.
 */

const NOW = 1_750_000_000;

let stores: Stores | null = null;
beforeAll(async () => {
  stores = await startStores();
}, 180_000);
afterAll(async () => {
  await stopStores(stores);
});

describe('teardown fences NEW spends before reclaiming float (M8, teardown.ts:24)', () => {
  it('suspends the agent BEFORE reclaim is called, and the new-spend fence persists post-teardown', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, apiKey } = await seedAgent(pool, redis, 10);

    // Seed $25 of confirmed float to reclaim (no pending allocations — the sweep is a no-op here).
    await redis.set(keys.floatConfirmed(agentId), usdc(25).toString());
    await redis.set(keys.allocationCommitted(orgId), usdc(25).toString());

    // The transport records the agent's DB status AT THE MOMENT reclaim-for is invoked → proves the
    // suspend was ordered first.
    const statusAtReclaim: string[] = [];
    const transport: GatewayTransport = {
      request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
        if (req.path === '/v1/gateway/reclaim-for') {
          return pool
            .query<{ status: string }>('SELECT status FROM agents WHERE id = $1', [agentId])
            .then((r) => {
              statusAtReclaim.push(r.rows[0]?.status ?? 'missing');
              return { id: `gw_reclaim_${statusAtReclaim.length}` } as T;
            });
        }
        return Promise.reject(new Error(`unexpected path ${req.path}`));
      },
    };
    const deps: ProvisionDeps = { pool, redis, gateway: new GatewayClient(transport) };

    const result = await teardownAgent(deps, { orgId, agentId, now: NOW });

    expect(result.withdrawn).toBe(usdc(25)); // the reclaim still happens
    expect(statusAtReclaim).toEqual(['suspended']); // … but only AFTER the fence is up

    // The fence persists: a post-teardown authorize attempt is refused by the hot-path auth gate.
    const auth = await authenticateAgent(pool, `Bearer ${apiKey}`);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe('agent_suspended');
  });
});
