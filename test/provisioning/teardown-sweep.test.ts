import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GatewayClient, type GatewayTransport } from '../../src/lib/circle/gateway.js';
import { depositFor, type ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { confirmDeposit } from '../../src/engines/provisioning/confirm.js';
import { teardownAgent } from '../../src/engines/provisioning/teardown.js';
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
 * E5 teardown sweep (doc-04 M6, BUG-21, SPIKE-03). Tearing down an agent must leave NO stranded
 * `float_pending`: every in-flight depositFor is swept — promoted if its op is already final, else
 * cancelled (its pending float AND its budget reserve released) — and the remaining confirmed float is
 * reclaimed to the treasury as ONE balanced `teardown` allocation pair that flips direction (agent-float →
 * treasury, the inverse of a depositFor). SPIKE-03 OPEN: the cancel path is optimistic — a cancelled op
 * that later settles on-chain would credit untracked float; SPIKE-03 must choose mempool-cancel vs
 * await-finality before production. Requires Docker; skips when no container runtime is available.
 */

const NOW = 1_750_000_000;

/** A Circle transport for teardown: deposit-for hands distinct op ids, reclaim-for is recorded, and the
 *  operation-finality read reports `complete` only for txRefs explicitly marked final. */
function teardownGateway(): {
  gateway: GatewayClient;
  markFinal: (txRef: string) => void;
  reclaims: Array<{ orgId: string; agentId: string; amount: string }>;
} {
  const final = new Set<string>();
  const reclaims: Array<{ orgId: string; agentId: string; amount: string }> = [];
  let n = 0;
  const transport: GatewayTransport = {
    request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      if (req.path === '/v1/gateway/deposit-for') {
        n += 1;
        return Promise.resolve({ id: `gw_tx_${n}` } as T);
      }
      if (req.path === '/v1/gateway/reclaim-for') {
        const b = req.body as { orgId: string; agentId: string; amount: string };
        reclaims.push({ orgId: b.orgId, agentId: b.agentId, amount: b.amount });
        return Promise.resolve({ id: `gw_reclaim_${reclaims.length}` } as T);
      }
      if (req.path.startsWith('/v1/gateway/operations/')) {
        const id = req.path.slice('/v1/gateway/operations/'.length);
        return Promise.resolve({ status: final.has(id) ? 'complete' : 'pending' } as T);
      }
      return Promise.reject(new Error(`unexpected path ${req.path}`));
    },
  };
  return { gateway: new GatewayClient(transport), markFinal: (t: string) => { final.add(t); }, reclaims };
}

/** isFinal reports `complete` the FIRST time a given op is queried, then `pending` afterwards — simulating
 *  a finality read that flips between two reads. Teardown must STILL guarantee float_pending==0 (BUG-21);
 *  it must never trust an optimistic read and leave a deposit stranded PENDING. */
function flipFinalGateway(): {
  gateway: GatewayClient;
  reclaims: Array<{ orgId: string; agentId: string; amount: string }>;
} {
  const seen = new Set<string>();
  const reclaims: Array<{ orgId: string; agentId: string; amount: string }> = [];
  let n = 0;
  const transport: GatewayTransport = {
    request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      if (req.path === '/v1/gateway/deposit-for') {
        n += 1;
        return Promise.resolve({ id: `gw_tx_${n}` } as T);
      }
      if (req.path === '/v1/gateway/reclaim-for') {
        const b = req.body as { orgId: string; agentId: string; amount: string };
        reclaims.push({ orgId: b.orgId, agentId: b.agentId, amount: b.amount });
        return Promise.resolve({ id: `gw_reclaim_${reclaims.length}` } as T);
      }
      if (req.path.startsWith('/v1/gateway/operations/')) {
        const id = req.path.slice('/v1/gateway/operations/'.length);
        const first = !seen.has(id);
        seen.add(id);
        return Promise.resolve({ status: first ? 'complete' : 'pending' } as T);
      }
      return Promise.reject(new Error(`unexpected path ${req.path}`));
    },
  };
  return { gateway: new GatewayClient(transport), reclaims };
}

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('teardown sweep — no stranded float_pending, confirmed float reclaimed (E5/L5, BUG-21)', () => {
  it('cancels a still-pending deposit and reclaims confirmed float to treasury as a teardown pair', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, markFinal, reclaims } = teardownGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const base = (amount: bigint, now: number) => ({
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount,
      policy: allocation,
      kind: 'depositFor' as const,
      secondsSinceLastAllocation: null,
      now,
    });

    // A confirmed $50 deposit — its op is marked final, so it promotes before teardown.
    const d1 = await depositFor(deps, base(usdc(50), NOW));
    const id1 = d1.outcome === 'SUBMITTED' ? d1.allocationId : '';
    const tx1 = await redis.hget(keys.allocation(id1), 'txRef');
    markFinal(tx1 ?? '');
    expect(await confirmDeposit(deps, { allocationId: id1, now: NOW + 30 })).toBe('CONFIRMED');

    // A still-pending $30 deposit — its op is never marked final, so it stays PENDING and is indexed.
    const d2 = await depositFor(deps, base(usdc(30), NOW + 60));
    const id2 = d2.outcome === 'SUBMITTED' ? d2.allocationId : '';
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(30).toString());
    expect(await redis.scard(keys.pendingAllocations(agentId))).toBe(1);

    const result = await teardownAgent(deps, { orgId, agentId, now: NOW + 120 });
    expect(result.sweptPending).toBe(1);
    expect(result.withdrawn).toBe(usdc(50));

    // BUG-21 invariant: no stranded pending float; confirmed float reclaimed to zero.
    expect(await redis.get(keys.floatPending(agentId))).toBe('0');
    expect(await redis.get(keys.floatConfirmed(agentId))).toBe('0');
    // The pending deposit's budget reserve was released; the confirmed deposit's commit was returned.
    expect(await redis.get(keys.allocationReserved(orgId))).toBe('0');
    expect(await redis.get(keys.allocationCommitted(orgId))).toBe('0');
    expect(
      computeSpendable({ floatConfirmed: 0n, consumed: 0n, reserved: 0n, escrowReserved: 0n }),
    ).toBe(0n);
    // Both in-flight records cleared and the per-agent index emptied.
    expect(await redis.exists(keys.allocation(id2))).toBe(0);
    expect(await redis.scard(keys.pendingAllocations(agentId))).toBe(0);

    // Exactly one reclaim through the single Circle wrapper, for the confirmed $50.
    expect(reclaims).toEqual([{ orgId, agentId, amount: usdc(50).toString() }]);

    // The teardown ledger pair flips direction: debit agent-float / credit treasury (funds return home).
    const td = await pool.query(
      `SELECT account, direction, amount, kind FROM allocation_events
       WHERE org_id = $1 AND kind = 'teardown' ORDER BY account`,
      [orgId],
    );
    expect(td.rows).toEqual([
      { account: 'agent-float', direction: 'debit', amount: usdc(50).toString(), kind: 'teardown' },
      { account: 'treasury', direction: 'credit', amount: usdc(50).toString(), kind: 'teardown' },
    ]);
    // The cancelled pending deposit wrote NO ledger rows (it never committed): 1 depositFor pair + 1 teardown pair.
    const all = await pool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM allocation_events WHERE org_id = $1',
      [orgId],
    );
    expect(all.rows[0]?.c).toBe(4);

    // Idempotent: a second teardown of the same (now-empty) agent moves nothing and writes nothing.
    const again = await teardownAgent(deps, { orgId, agentId, now: NOW + 200 });
    expect(again.sweptPending).toBe(0);
    expect(again.withdrawn).toBe(0n);
    expect(reclaims).toEqual([{ orgId, agentId, amount: usdc(50).toString() }]); // still exactly one
    const all2 = await pool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM allocation_events WHERE org_id = $1',
      [orgId],
    );
    expect(all2.rows[0]?.c).toBe(4); // no new ledger rows
  });

  it('guarantees float_pending==0 even if finality flips between reads (no stranded pending)', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway } = flipFinalGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const d = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(25),
      policy: allocation,
      kind: 'depositFor',
      secondsSinceLastAllocation: null,
      now: NOW,
    });
    expect(d.outcome).toBe('SUBMITTED');
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(25).toString());

    // The deposit MUST be resolved (promoted or cancelled) — never left PENDING — regardless of how the
    // finality reads land across the sweep. A single source of finality truth (confirmDeposit) is required.
    const result = await teardownAgent(deps, { orgId, agentId, now: NOW + 60 });
    expect(result.sweptPending).toBe(1);
    expect(await redis.get(keys.floatPending(agentId))).toBe('0');
    expect(await redis.scard(keys.pendingAllocations(agentId))).toBe(0);
    expect(await redis.exists(keys.allocation(d.outcome === 'SUBMITTED' ? d.allocationId : ''))).toBe(0);
  });

  it('promotes a now-final pending deposit during the sweep, then reclaims it', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const { gateway, markFinal, reclaims } = teardownGateway();
    const deps: ProvisionDeps = { pool, redis, gateway };

    const d = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(40),
      policy: allocation,
      kind: 'depositFor',
      secondsSinceLastAllocation: null,
      now: NOW,
    });
    const id = d.outcome === 'SUBMITTED' ? d.allocationId : '';
    expect(await redis.get(keys.floatPending(agentId))).toBe(usdc(40).toString());

    // The op reaches finality exactly as teardown runs → swept by PROMOTE (not cancel), then reclaimed.
    const tx = await redis.hget(keys.allocation(id), 'txRef');
    markFinal(tx ?? '');

    const result = await teardownAgent(deps, { orgId, agentId, now: NOW + 60 });
    expect(result.sweptPending).toBe(1);
    expect(result.withdrawn).toBe(usdc(40));
    expect(await redis.get(keys.floatPending(agentId))).toBe('0');
    expect(await redis.get(keys.floatConfirmed(agentId))).toBe('0');
    expect(await redis.get(keys.allocationCommitted(orgId))).toBe('0');
    expect(await redis.scard(keys.pendingAllocations(agentId))).toBe(0);

    // One reclaim for $40; the ledger holds the promote depositFor pair + the teardown pair.
    expect(reclaims).toEqual([{ orgId, agentId, amount: usdc(40).toString() }]);
    const rows = await pool.query<{ kind: string }>(
      'SELECT kind FROM allocation_events WHERE org_id = $1',
      [orgId],
    );
    const kinds = rows.rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'depositFor').length).toBe(2);
    expect(kinds.filter((k) => k === 'teardown').length).toBe(2);
  });
});
