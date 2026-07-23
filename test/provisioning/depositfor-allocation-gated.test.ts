import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';
import { depositFor, type ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { keys } from '../../src/redis/keyspace.js';
import { computeSpendable } from '../../src/engines/custody/balance.js';
import {
  startStores,
  stopStores,
  seedAgent,
  agentFloat,
  VENDOR,
  usdc,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * E5 Provisioning — `depositFor` (engine-specs-FINAL.md:128, policy-engine-FINAL.md:253-262, BUG-29).
 *
 * A treasury→own-agent float top-up is gated by the P3-B AllocationPolicy evaluator: the own-agent
 * destination fence + per-agent max + the atomic budget reserve all run BEFORE any money moves, so a
 * DENY reserves nothing and never calls Circle. An allowed request reserves the org budget, submits the
 * internal allocation through the single Circle Gateway wrapper, and increments `float_pending` ONLY —
 * pending float is NEVER spendable (the deposit raises spendable only after L3 promotes it on on-chain
 * finality). A Gateway submit failure releases the reserve so a transient network error never strands
 * org budget. Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;

/** A recording Casper treasury client stub that returns a fixed op id; exercises the depositFor call shape. */
function recordingGateway(): { gateway: CasperTreasuryClient; calls: Array<{ path: string; body?: unknown }> } {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const gateway: CasperTreasuryClient = {
    getBalances: vi.fn(),
    deposit: vi.fn(),
    depositFor: vi.fn(async (params: { orgId: string; agentId: string; amount: bigint }) => {
      calls.push({
        path: '/v1/gateway/deposit-for',
        body: { orgId: params.orgId, agentId: params.agentId, amount: params.amount.toString() },
      });
      return { id: 'gw_tx_1' };
    }),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(),
  };
  return { gateway, calls };
}

/** A Casper treasury client stub that always fails — to assert the reserve is compensated on a submit error. */
function failingGateway(): CasperTreasuryClient {
  return {
    getBalances: vi.fn(),
    deposit: vi.fn(),
    depositFor: vi.fn(async () => {
      throw new Error('gateway 503');
    }),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(),
  };
}

let stores: Stores | null = null;

beforeAll(async () => {
  stores = await startStores();
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

describe('depositFor — P3-B allocation-gated, two-phase float_pending (BUG-29)', () => {
  it('SUBMITS an allowed deposit: reserves budget, raises float_pending, leaves spendable unchanged', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, calls } = recordingGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const result = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(50),
      policy: allocation,
      kind: 'depositFor',
      secondsSinceLastAllocation: null,
      now: NOW,
    });

    expect(result.outcome).toBe('SUBMITTED');
    const allocationId = result.outcome === 'SUBMITTED' ? result.allocationId : '';
    expect(allocationId.startsWith('alloc_')).toBe(true);

    // Org budget reserved (atomic P3-B reserve).
    expect(await redis.get(keys.allocationReserved(orgId))).toBe(usdc(50).toString());
    // float_pending raised by exactly the deposit; float_confirmed untouched.
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(50).toString());
    expect(await redis.get(keys.floatConfirmed(agentId))).toBeNull();
    // BUG-29: pending float is NOT spendable — spendable is computed from confirmed only.
    const confirmed = BigInt((await redis.get(keys.floatConfirmed(agentId))) ?? '0');
    expect(
      computeSpendable({ floatConfirmed: confirmed, consumed: 0n, reserved: 0n, escrowReserved: 0n }),
    ).toBe(0n);

    // An in-flight PENDING allocation record persists for L3 finality promotion.
    const h = await redis.hgetall(keys.allocation(allocationId));
    expect(h.state).toBe('PENDING');
    expect(h.kind).toBe('depositFor');
    expect(h.amount).toBe(usdc(50).toString());
    expect(h.agentId).toBe(agentId);
    expect(h.orgId).toBe(orgId);
    expect(h.txRef).toBe('gw_tx_1');

    // The internal allocation went through the single Circle wrapper's deposit-for path.
    expect(calls).toEqual([
      { path: '/v1/gateway/deposit-for', body: { orgId, agentId, amount: usdc(50).toString() } },
    ]);
  });

  it('DENIES a destination outside the own-agent fence and moves no money / never calls Circle', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, calls } = recordingGateway();

    const result = await depositFor(
      { pool, redis, gateway },
      {
        orgId,
        agentId,
        agentFloatAddress: VENDOR, // external address — not in allowedDestinations (own agents only)
        amount: usdc(50),
        policy: allocation,
        kind: 'depositFor',
        secondsSinceLastAllocation: null,
        now: NOW,
      },
    );

    expect(result).toEqual({ outcome: 'DENY', reason: 'service_not_allowed' });
    expect(await redis.get(keys.allocationReserved(orgId))).toBeNull();
    expect(await redis.get(keys.floatPending(agentId))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('DENIES a deposit over per_agent_max and moves no money', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, calls } = recordingGateway();

    const result = await depositFor(
      { pool, redis, gateway },
      {
        orgId,
        agentId,
        agentFloatAddress: agentFloat.address,
        amount: usdc(1001), // perAgentMax is usdc(1000)
        policy: allocation,
        kind: 'depositFor',
        secondsSinceLastAllocation: null,
        now: NOW,
      },
    );

    expect(result).toEqual({ outcome: 'DENY', reason: 'allocation_exceeded' });
    expect(await redis.get(keys.allocationReserved(orgId))).toBeNull();
    expect(await redis.get(keys.floatPending(agentId))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('releases the reserve when the Gateway submit fails — no stranded org budget', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);

    await expect(
      depositFor(
        { pool, redis, gateway: failingGateway() },
        {
          orgId,
          agentId,
          agentFloatAddress: agentFloat.address,
          amount: usdc(50),
          policy: allocation,
          kind: 'depositFor',
          secondsSinceLastAllocation: null,
          now: NOW,
        },
      ),
    ).rejects.toThrow();

    // The atomic reserve was compensated back to zero; pending float was never raised; no record left.
    expect(BigInt((await redis.get(keys.allocationReserved(orgId))) ?? '0')).toBe(0n);
    expect(await redis.get(keys.floatPending(agentId))).toBeNull();
  });
});
