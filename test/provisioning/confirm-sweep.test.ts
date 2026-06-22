import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, usdc, type Stores } from '../helpers/oracle-harness.js';
import { seedAgent } from '../helpers/oracle-harness.js';
import { GatewayClient, type GatewayTransport } from '../../src/lib/circle/gateway.js';
import { depositFor, type ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { sweepPendingConfirmations } from '../../src/engines/provisioning/confirm-sweep.js';
import { keys } from '../../src/redis/keyspace.js';

function controllableGateway(): { gateway: GatewayClient; setFinal: (v: boolean) => void } {
  let final = false;
  const transport: GatewayTransport = {
    request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      if (req.path === '/v1/gateway/deposit-for') return Promise.resolve({ id: 'gw_tx_1' } as T);
      if (req.path.startsWith('/v1/gateway/operations/'))
        return Promise.resolve({ status: final ? 'complete' : 'pending' } as T);
      return Promise.reject(new Error(`unexpected ${req.path}`));
    },
  };
  return { gateway: new GatewayClient(transport), setFinal: (v) => { final = v; } };
}

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('sweepPendingConfirmations promotes pending floats only on finality', () => {
  it('leaves pending when not final, confirms after finality', async ({ skip }) => {
    if (!stores) return skip();
    const { pool, redis } = stores;
    const seeded = await seedAgent(pool, redis, 100);
    const { orgId, agentId, allocation } = seeded;
    // allowedDestinations[0] is the shared agentFloat.address from oracle-harness
    const agentFloatAddress = allocation.allowedDestinations[0] as string;
    const { gateway, setFinal } = controllableGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    // Submit a deposit: float_pending += 50 USDC, allocationId indexed in pendingAllocations
    await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress,
      amount: usdc(50),
      policy: allocation,
      kind: 'depositFor',
      secondsSinceLastAllocation: null,
      now: 1000,
    });

    // Sweep BEFORE finality — gateway returns 'pending', so confirmDeposit returns 'PENDING'
    const r1 = await sweepPendingConfirmations(deps, { now: 1030 });
    expect(r1.confirmed).toBe(0);
    expect(r1.pending).toBe(1);
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(50).toString());

    // Toggle finality — gateway now returns 'complete'
    setFinal(true);
    const r2 = await sweepPendingConfirmations(deps, { now: 1060 });
    expect(r2.confirmed).toBe(1);
    expect(r2.pending).toBe(0);
    expect(await redis.get(keys.floatConfirmed(agentId))).toBe(usdc(50).toString());
    expect(await redis.get(keys.floatPending(agentId))).toBe('0');
  });
});
