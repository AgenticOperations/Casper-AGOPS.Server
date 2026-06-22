import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Redis } from 'ioredis';
import { GatewayClient, type GatewayTransport } from '../../src/lib/circle/gateway.js';
import { depositFor, type ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { confirmDeposit } from '../../src/engines/provisioning/confirm.js';
import { keys } from '../../src/redis/keyspace.js';
import { computeSpendable } from '../../src/engines/custody/balance.js';
import {
  startStores,
  stopStores,
  seedAgent,
  agentFloat,
  usdc,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * E5/E6 two-phase float (engine-specs-FINAL.md:178-179, BUG-29/39/42). A submitted depositFor raises
 * `float_pending`, which is NEVER spendable. `confirmDeposit` promotes pending→confirmed ONLY on positive
 * on-chain/operation finality — a not-yet-final or failed finality read leaves the deposit PENDING (never
 * promote on a blind timeout). Promotion is a single-winner atomic step: float_pending→float_confirmed and
 * allocation_reserved→allocation_committed move together, one balanced allocation_events pair is recorded,
 * and a replayed confirm is a NOOP. Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;

/** A Circle transport handling both the deposit-for POST and the operation-finality GET, with a toggle. */
function controllableGateway(): { gateway: GatewayClient; setFinal: (v: boolean) => void } {
  let final = false;
  const transport: GatewayTransport = {
    request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      if (req.path === '/v1/gateway/deposit-for') return Promise.resolve({ id: 'gw_tx_1' } as T);
      if (req.path.startsWith('/v1/gateway/operations/')) {
        return Promise.resolve({ status: final ? 'complete' : 'pending' } as T);
      }
      return Promise.reject(new Error(`unexpected path ${req.path}`));
    },
  };
  return { gateway: new GatewayClient(transport), setFinal: (v: boolean) => { final = v; } };
}

/** deposit-for succeeds, but the finality read always fails — to assert "never promote on a blind error". */
function depositOkFinalityThrows(): GatewayClient {
  const transport: GatewayTransport = {
    request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      if (req.path === '/v1/gateway/deposit-for') return Promise.resolve({ id: 'gw_tx_1' } as T);
      return Promise.reject(new Error('rpc_unavailable'));
    },
  };
  return new GatewayClient(transport);
}

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

async function spendableOf(redis: Redis, agentId: string): Promise<bigint> {
  const confirmed = BigInt((await redis.get(keys.floatConfirmed(agentId))) ?? '0');
  return computeSpendable({ floatConfirmed: confirmed, consumed: 0n, reserved: 0n, escrowReserved: 0n });
}

const depositParams = (orgId: string, agentId: string, allocation: import('../../src/contracts/index.js').AllocationPolicy) => ({
  orgId,
  agentId,
  agentFloatAddress: agentFloat.address,
  amount: usdc(50),
  policy: allocation,
  kind: 'depositFor' as const,
  secondsSinceLastAllocation: null,
  now: NOW,
});

describe('two-phase float — confirmDeposit promotes pending→confirmed on finality (BUG-29/39/42)', () => {
  it('holds PENDING until final, then promotes: spendable rises only after confirmation', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, setFinal } = controllableGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const sub = await depositFor(deps, depositParams(orgId, agentId, allocation));
    expect(sub.outcome).toBe('SUBMITTED');
    const allocationId = sub.outcome === 'SUBMITTED' ? sub.allocationId : '';

    // Before finality: pending float exists, but spendable (confirmed-based) is still zero.
    expect(await spendableOf(redis, agentId)).toBe(0n);
    expect(await confirmDeposit(deps, { allocationId, now: NOW + 30 })).toBe('PENDING');
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(50).toString());
    expect(await spendableOf(redis, agentId)).toBe(0n);

    // Finality reached → single-winner promotion.
    setFinal(true);
    expect(await confirmDeposit(deps, { allocationId, now: NOW + 60 })).toBe('CONFIRMED');
    expect(await redis.get(keys.floatPending(agentId))).toBe('0');
    expect(await redis.get(keys.floatConfirmed(agentId))).toBe(usdc(50).toString());
    expect(await redis.get(keys.allocationReserved(orgId))).toBe('0');
    expect(await redis.get(keys.allocationCommitted(orgId))).toBe(usdc(50).toString());
    expect(await spendableOf(redis, agentId)).toBe(usdc(50));
    expect(await redis.exists(keys.allocation(allocationId))).toBe(0); // in-flight record cleared

    // Exactly one balanced allocation_events pair (debit treasury / credit agent-float), kind depositFor.
    const rows = await pool.query(
      'SELECT account, direction, amount, kind FROM allocation_events WHERE allocation_id = $1 ORDER BY account',
      [allocationId],
    );
    expect(rows.rows).toEqual([
      { account: 'agent-float', direction: 'credit', amount: usdc(50).toString(), kind: 'depositFor' },
      { account: 'treasury', direction: 'debit', amount: usdc(50).toString(), kind: 'depositFor' },
    ]);
  });

  it('never promotes on a blind finality-read failure (LOCKED PENDING, BUG-39/42)', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const deps: ProvisionDeps = { pool, redis, gateway: depositOkFinalityThrows() };

    const sub = await depositFor(deps, depositParams(orgId, agentId, allocation));
    const allocationId = sub.outcome === 'SUBMITTED' ? sub.allocationId : '';

    expect(await confirmDeposit(deps, { allocationId, now: NOW + 60 })).toBe('PENDING');
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(50).toString());
    expect(await redis.get(keys.floatConfirmed(agentId))).toBeNull();
    // The in-flight record is untouched (still promotable once finality is readable).
    expect(await redis.exists(keys.allocation(allocationId))).toBe(1);
  });

  it('is idempotent: a replayed confirm is a NOOP — no double promotion, exactly one ledger pair', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, setFinal } = controllableGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const sub = await depositFor(deps, depositParams(orgId, agentId, allocation));
    const allocationId = sub.outcome === 'SUBMITTED' ? sub.allocationId : '';
    setFinal(true);

    expect(await confirmDeposit(deps, { allocationId, now: NOW + 60 })).toBe('CONFIRMED');
    expect(await confirmDeposit(deps, { allocationId, now: NOW + 90 })).toBe('NOOP');
    expect(await redis.get(keys.floatConfirmed(agentId))).toBe(usdc(50).toString());
    expect(await redis.get(keys.allocationCommitted(orgId))).toBe(usdc(50).toString());
    const n = await pool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM allocation_events WHERE allocation_id = $1',
      [allocationId],
    );
    expect(n.rows[0]?.c).toBe(2);
  });
});
