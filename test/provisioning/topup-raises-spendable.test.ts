import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';
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
 * E5 top-up (engine-specs-FINAL.md:128, doc-04 M6). A `kind:'topup'` deposit is the same P3-B-gated,
 * two-phase path as `depositFor` — the only difference is the ledger `kind`. A confirmed top-up on an
 * agent that already holds confirmed float raises spendable ADDITIVELY by the top-up amount, and lands a
 * second, independent balanced allocation_events pair tagged `topup`. Requires Docker; skips without one.
 */

const NOW = 1_750_000_000;

/** A gateway that is always final and hands each deposit a distinct op id (so txRefs do not collide). */
function alwaysFinalGateway(): CasperTreasuryClient {
  let n = 0;
  return {
    getBalances: vi.fn(),
    deposit: vi.fn(),
    depositFor: vi.fn(async () => {
      n += 1;
      return { id: `gw_tx_${n}` };
    }),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(async () => true),
  };
}

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('top-up — kind:topup raises spendable additively once confirmed (E5/L4)', () => {
  it('a confirmed top-up on an agent with existing confirmed float increases spendable by the top-up', async ({ skip }) => {
    if (!stores) return skip();
    const { redis, pool } = stores;
    const { orgId, agentId, allocation } = await seedAgent(pool, redis, 10);
    const deps: ProvisionDeps = { pool, redis, gateway: alwaysFinalGateway() };

    // Initial depositFor $50 → confirmed → spendable $50.
    const d1 = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(50),
      policy: allocation,
      // Org is funded well beyond these asks — this suite exercises the POLICY bounds, not solvency.
      fundedTotal: usdc(1_000_000),
      kind: 'depositFor',
      secondsSinceLastAllocation: null,
      now: NOW,
    });
    const id1 = d1.outcome === 'SUBMITTED' ? d1.allocationId : '';
    expect(await confirmDeposit(deps, { allocationId: id1, now: NOW + 60 })).toBe('CONFIRMED');

    // Top-up $30 → confirmed → spendable rises additively to $80.
    const d2 = await depositFor(deps, {
      orgId,
      agentId,
      agentFloatAddress: agentFloat.address,
      amount: usdc(30),
      policy: allocation,
      // Org is funded well beyond these asks — this suite exercises the POLICY bounds, not solvency.
      fundedTotal: usdc(1_000_000),
      kind: 'topup',
      secondsSinceLastAllocation: 120,
      now: NOW + 120,
    });
    expect(d2.outcome).toBe('SUBMITTED');
    const id2 = d2.outcome === 'SUBMITTED' ? d2.allocationId : '';
    expect(id2).not.toBe(id1);
    expect(await confirmDeposit(deps, { allocationId: id2, now: NOW + 180 })).toBe('CONFIRMED');

    const confirmed = BigInt((await redis.get(keys.floatConfirmed(agentId))) ?? '0');
    expect(confirmed).toBe(usdc(80));
    expect(
      computeSpendable({ floatConfirmed: confirmed, consumed: 0n, reserved: 0n, escrowReserved: 0n }),
    ).toBe(usdc(80));
    expect(await redis.get(keys.allocationCommitted(orgId))).toBe(usdc(80).toString());

    // Two independent ledger records for this org: one depositFor pair, one topup pair (2 rows each).
    const rows = await pool.query<{ kind: string }>(
      'SELECT kind FROM allocation_events WHERE org_id = $1',
      [orgId],
    );
    const kinds = rows.rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'depositFor').length).toBe(2);
    expect(kinds.filter((k) => k === 'topup').length).toBe(2);
  });
});
