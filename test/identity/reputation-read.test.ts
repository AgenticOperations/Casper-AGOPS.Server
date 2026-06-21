import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createOrg, registerAgent } from '../../src/engines/control/store.js';
import { recordSettlement } from '../../src/engines/ledger/events.js';
import { getReputation } from '../../src/engines/identity/reputation.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import type { Rail } from '../../src/contracts/index.js';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

/**
 * E7 reputation read API, ledger-sourced (engine-specs-FINAL.md:227,229,233). `getReputation` reads an
 * agent's settled-job facts from the cold `spend_events` journal (each credit row = one arms-length
 * vendor job) and recomputes the BUG-28 score. Read-side: a score, or UNRATED for a thin history.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const RAIL: Rail = { scheme: 'raw-x402', chain: 'arc' };
const NOW = Math.floor(Date.parse('2026-06-20T00:00:00Z') / 1000);
const USD = 1_000_000n;

let stores: Stores | null = null;

beforeAll(async () => {
  stores = await startStores();
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

describe('getReputation — ledger-sourced read-side score (BUG-28)', () => {
  it('rates an agent with ≥5 distinct vendor counterparties, ≥$10, ≥7 days of settled jobs', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { pool } = stores;
    const org = await createOrg(pool, { name: 'RepCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    // 5 settled spends to 5 distinct vendors, $5 each ($25 total); the oldest 19 days back → span ≥7d.
    for (let i = 0; i < 5; i++) {
      const settled = new Date(i === 0 ? '2026-06-01T00:00:00Z' : '2026-06-19T00:00:00Z');
      await recordSettlement(pool, {
        paymentId: `pay_rep_${i}`,
        agentId: agent.id,
        orgId: org.id,
        rail: RAIL,
        resourceId: 'svc:summarize',
        destination: `0xvendor${i}`,
        requested: 5n * USD,
        consumed: 5n * USD,
        policyRef: 'policy_rep@v1',
        enforcementTimestamp: new Date('2026-05-31T00:00:00Z'),
        settlementTimestamp: settled,
      });
    }

    const r = await getReputation({ pool }, { agentId: agent.id, now: NOW });
    expect(r.rated).toBe(true);
    if (r.rated) {
      expect(r.uniqueCounterparties).toBe(5);
      expect(r.capitalAtRisk).toBe(25n * USD);
    }
  });

  it('returns UNRATED for an agent with a single settled job', async ({ skip }) => {
    if (!stores) return skip();
    const { pool } = stores;
    const org = await createOrg(pool, { name: 'ThinCo', adminKeyHash: issueAdminKey().hash });
    const { agent } = await registerAgent(pool, { orgId: org.id });

    await recordSettlement(pool, {
      paymentId: 'pay_thin_0',
      agentId: agent.id,
      orgId: org.id,
      rail: RAIL,
      resourceId: 'svc:summarize',
      destination: '0xlonelyvendor',
      requested: 5n * USD,
      consumed: 5n * USD,
      policyRef: 'policy_thin@v1',
      enforcementTimestamp: new Date('2026-06-18T00:00:00Z'),
      settlementTimestamp: new Date('2026-06-18T00:00:01Z'),
    });

    const r = await getReputation({ pool }, { agentId: agent.id, now: NOW });
    expect(r).toEqual({ rated: false, status: 'UNRATED' });
  });
});
