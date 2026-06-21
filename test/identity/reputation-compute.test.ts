import { describe, it, expect } from 'vitest';
import type { JobFact } from '../../src/contracts/index.js';
import { computeReputation } from '../../src/engines/identity/reputation.js';

/**
 * E7 reputation compute — the anti-wash-trading formula (BUG-28, engine-specs-FINAL.md:229):
 *   score = f(unique_counterparties, capital_at_risk, completion_rate, dispute_rate, recency_weight)
 * with six locked rules. The pure compute is exhaustively unit-testable; the combining curve f() is
 * NOT spec-frozen (only its inputs + rules are), so its weights are calibration params and these tests
 * assert rule DIRECTION / thresholds, never magic score values. Reputation is a dimensionless trust
 * score, NOT money, so Number arithmetic is fine; capital-at-risk stays bigint.
 */

const NOW = 1_800_000_000;
const DAY = 86_400;
const USD = 1_000_000n; // $1 in USDC base units (6dp)

function job(over: Partial<JobFact> = {}): JobFact {
  return {
    counterparty: 'vendor_default',
    counterpartyOrgId: null, // external vendor → no self-loop
    agentOrgId: 'org_rated',
    capitalAtRisk: 5n * USD, // $5
    completed: true,
    disputed: false,
    settledAt: NOW - 1 * DAY,
    ...over,
  };
}

/** N jobs across `distinct` counterparties (round-robin), each `amount`, all at `ageDays`. */
function spread(
  count: number,
  distinct: number,
  amount: bigint,
  ageDays: number,
  over: Partial<JobFact> = {},
): JobFact[] {
  return Array.from({ length: count }, (_, i) =>
    job({ counterparty: `cp_${i % distinct}`, capitalAtRisk: amount, settledAt: NOW - ageDays * DAY, ...over }),
  );
}

function rate(facts: JobFact[]) {
  return computeReputation(facts, { now: NOW });
}

describe('computeReputation — E7 anti-wash-trading (BUG-28)', () => {
  it('rates an agent that clears all three thresholds (≥5 distinct, ≥$10, ≥7 days)', () => {
    // 5 distinct counterparties, $5 each ($25 total), span 10 days.
    const facts = spread(5, 5, 5n * USD, 1).map((f, i) =>
      i === 0 ? { ...f, settledAt: NOW - 10 * DAY } : f,
    );
    const r = rate(facts);
    expect(r.rated).toBe(true);
    if (r.rated) {
      expect(r.uniqueCounterparties).toBe(5);
      expect(r.capitalAtRisk).toBe(25n * USD);
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('is UNRATED until ≥5 unique counterparties AND ≥$10 capital AND ≥7 days history (rule 6)', () => {
    // (a) only 4 distinct counterparties — fails the count even though capital/age pass.
    expect(rate(spread(4, 4, 10n * USD, 10)).rated).toBe(false);
    // (b) 5 distinct but only $1 each = $5 total < $10 — fails capital.
    expect(rate(spread(5, 5, 1n * USD, 10)).rated).toBe(false);
    // (c) 5 distinct, $5 each = $25, but all settled <7 days ago — fails history span.
    expect(rate(spread(5, 5, 5n * USD, 1))).toEqual({ rated: false, status: 'UNRATED' });
  });

  it('excludes self-loop jobs where payer and payee share an org (rule 1)', () => {
    // Would clear every threshold, but every counterparty is the agent's own org → all dropped.
    const selfLoop = spread(5, 5, 5n * USD, 10, { counterpartyOrgId: 'org_rated' });
    expect(rate(selfLoop)).toEqual({ rated: false, status: 'UNRATED' });
  });

  it('excludes dust (< $0.10) and sub-$1 jobs from counting (rule 3)', () => {
    // 5 distinct counterparties but each only $0.50 — below the $1 min-to-count → nothing counts.
    expect(rate(spread(5, 5, 500_000n, 10)).rated).toBe(false);
    // a pure-dust ($0.05) history likewise does not count.
    expect(rate(spread(6, 6, 50_000n, 10)).rated).toBe(false);
  });

  it('damps cross-org collusion: fewer distinct counterparties scores strictly lower (rule 2)', () => {
    // Equal job count (10) and equal total capital ($30); only the breadth of counterparties differs.
    const many = rate(spread(10, 10, 3n * USD, 10)); // 10 distinct
    const few = rate(spread(10, 5, 3n * USD, 10)); // 5 distinct (each used twice)
    expect(many.rated && few.rated).toBe(true);
    if (many.rated && few.rated) {
      expect(few.score).toBeLessThan(many.score);
      // Direction alone is too weak: a regression that zeroes the diversity weight would still pass.
      // Under the shipped default weights, halving distinct counterparties must move the score by a
      // MATERIAL amount, so the anti-wash diversity term cannot be silently neutralized.
      expect(many.score - few.score).toBeGreaterThan(0.05);
    }
  });

  it('decays with recency: older settled jobs score lower (≈90-day half-life, rule 4)', () => {
    const recent = rate(spread(5, 5, 5n * USD, 8)); // ~8 days old
    const old = rate(spread(5, 5, 5n * USD, 98)); // ~98 days old (>1 half-life older)
    expect(recent.rated && old.rated).toBe(true);
    if (recent.rated && old.rated) expect(old.score).toBeLessThan(recent.score);
  });

  it('penalizes disputes proportionally to disputed value (rule 5)', () => {
    const clean = rate(spread(5, 5, 5n * USD, 10));
    const disputed = spread(5, 5, 5n * USD, 10).map((f, i) => (i === 0 ? { ...f, disputed: true } : f));
    const withDispute = rate(disputed);
    expect(clean.rated && withDispute.rated).toBe(true);
    if (clean.rated && withDispute.rated) expect(withDispute.score).toBeLessThan(clean.score);
  });
});
