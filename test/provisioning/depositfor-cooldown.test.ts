import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';
import { depositFor, type ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { keys } from '../../src/redis/keyspace.js';
import {
  startStores,
  stopStores,
  seedAgent,
  agentFloat,
  usdc,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * E5/P3-B per-agent cooldown (engine-specs-FINAL.md:128, product-architecture-FINAL.md:139). The
 * AllocationPolicy rate-shapes re-allocation: a `depositFor` within `cooldownSeconds` of this agent's last
 * allocation is DENIED (`allocation_cooldown`) and moves nothing — it never reserves budget and never
 * reaches Circle. A first-ever allocation (no prior) and one after the cooldown has elapsed pass. Cooldown
 * is necessary-not-sufficient (multi-agent spread evades it; total_budget is the real bound) — it is a
 * request-local check, so it sits with per_agent_max BEFORE the atomic reserve. Requires Docker; skips
 * without a container runtime.
 */

const NOW = 1_750_000_000;

/** A gateway that records how many deposit-for submissions it received (to prove a DENY moves nothing). */
function recordingGateway(): { gateway: CasperTreasuryClient; state: { depositForCalls: number } } {
  const state = { depositForCalls: 0 };
  let n = 0;
  const gateway: CasperTreasuryClient = {
    getBalances: vi.fn(),
    deposit: vi.fn(),
    depositFor: vi.fn(async () => {
      state.depositForCalls += 1;
      n += 1;
      return { id: `gw_tx_${n}` };
    }),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(),
  };
  return { gateway, state };
}

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('depositFor cooldown — P3-B rate-shapes re-allocation (allocation_cooldown)', () => {
  it('denies a re-allocation inside the cooldown window and moves nothing', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, state } = recordingGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const decision = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(50),
      policy: { ...allocation, cooldownSeconds: 3600 },
      kind: 'depositFor',
      secondsSinceLastAllocation: 1800, // only 30 min since the last allocation < 1h cooldown.
      now: NOW,
    });

    expect(decision).toEqual({ outcome: 'DENY', reason: 'allocation_cooldown' });
    // A cooldown DENY reserves nothing and never reaches Circle.
    expect(state.depositForCalls).toBe(0);
    expect(await redis.get(keys.allocationReserved(orgId))).toBeNull();
    expect(await redis.get(keys.floatPending(agentId))).toBeNull();
  });

  it('allows a re-allocation once the cooldown has elapsed', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, state } = recordingGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const decision = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(50),
      policy: { ...allocation, cooldownSeconds: 3600 },
      kind: 'depositFor',
      secondsSinceLastAllocation: 3600, // exactly at the boundary — the cooldown has elapsed.
      now: NOW,
    });

    expect(decision.outcome).toBe('SUBMITTED');
    expect(state.depositForCalls).toBe(1);
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(50).toString());
  });

  it('allows the first-ever allocation (no prior allocation → no cooldown)', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, state } = recordingGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const decision = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(50),
      policy: { ...allocation, cooldownSeconds: 3600 },
      kind: 'depositFor',
      secondsSinceLastAllocation: null, // never allocated before.
      now: NOW,
    });

    expect(decision.outcome).toBe('SUBMITTED');
    expect(state.depositForCalls).toBe(1);
  });
});
