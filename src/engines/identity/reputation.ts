import type pg from 'pg';
import type { JobFact, ReputationResult } from '../../contracts/index.js';

/**
 * E7 reputation compute — the read-side, anti-wash-trading reputation score (BUG-28,
 * engine-specs-FINAL.md:227,229). This is the Verifier-service core: given settled-job facts (C-8),
 * recompute the score the ERC-8004 Reputation Registry holds. It is READ-SIDE and NEVER gates a
 * policy-valid payment (engine-specs-FINAL.md:237-243) — `UNRATED` is a trust default, not a payment
 * deny.
 *
 * The spec locks the formula INPUTS and six rules but NOT a closed form for f(); the combining curve
 * here is therefore parameterized ({@link ReputationWeights}) and treated as a calibration item (same
 * posture as SPIKE-02's watermark constants — not frozen). The threshold constants ARE spec-locked
 * (cited below). Reputation is a dimensionless trust score, not money, so the score uses Number;
 * capital-at-risk is summed and returned as bigint (money never becomes a float).
 *
 * Six locked rules (engine-specs-FINAL.md:229):
 *   1. self-loop exclusion — drop facts whose payee shares the payer's org.
 *   2. cross-org collusion damping — score on the BREADTH of distinct counterparties, not volume.
 *   3. dust < $0.10 / sub-$1 capital excluded — a job counts only at ≥ $1 capital-at-risk.
 *   4. recency decay — 90-day half-life on each job's contribution.
 *   5. dispute penalty — proportional to disputed value.
 *   6. UNRATED until ≥5 unique counterparties AND ≥$10 capital-at-risk AND ≥7 days history.
 */

const USD = 1_000_000n; // $1, USDC base units (6dp)

/** Spec-locked thresholds (engine-specs-FINAL.md:229). */
// rule 3 names two per-job thresholds — "dust < $0.10 excluded, min $1 capital-at-risk to count".
// The $1 "to count" floor is the binding one: it is grammatically the counting threshold and excludes
// everything the $0.10 dust line would and more, so a single ≥$1 filter is the faithful, dominant read
// (an *aggregate* $1 reading is dead — rule 6 already gates on ≥$10 aggregate). Both thresholds are
// cited so the no-fork mapping to engine-specs-FINAL.md:229 is auditable.
const MIN_CAPITAL_PER_JOB = 1n * USD; // $1 — a job counts toward the rating only at ≥ $1
const MIN_UNIQUE_COUNTERPARTIES = 5; // rule 6
const MIN_TOTAL_CAPITAL = 10n * USD; // rule 6: ≥ $10
const MIN_HISTORY_SECONDS = 7 * 24 * 60 * 60; // rule 6: ≥ 7 days
const RECENCY_HALF_LIFE_DAYS = 90; // rule 4
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Calibration weights for f() — NOT spec-frozen. Diversity is capped at a target breadth so volume
 * cannot substitute for distinct counterparties (rule 2). Defaults are a reasonable starting curve;
 * a future calibration spike tunes them. All terms land the final score in [0,1].
 */
export interface ReputationWeights {
  diversity: number;
  completion: number;
  recency: number;
  /** Subtractive penalty coefficient applied to the disputed-value fraction. */
  dispute: number;
  /** Distinct-counterparty count that earns full diversity marks. */
  diversityTarget: number;
}

const DEFAULT_WEIGHTS: ReputationWeights = {
  diversity: 0.4,
  completion: 0.3,
  recency: 0.3,
  dispute: 0.6,
  diversityTarget: 20,
};

// Frozen singleton: returned from multiple UNRATED exits, so freeze it to prevent a caller mutating
// the shared reference and corrupting every UNRATED result.
const UNRATED: ReputationResult = Object.freeze({ rated: false, status: 'UNRATED' } as const);

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function computeReputation(
  facts: JobFact[],
  opts: { now: number; weights?: ReputationWeights },
): ReputationResult {
  const w = opts.weights ?? DEFAULT_WEIGHTS;

  // Rule 1 (self-loop) + rule 3 (dust / sub-$1): keep only arms-length, ≥$1 jobs.
  const counted = facts.filter(
    (f) =>
      !(f.counterpartyOrgId !== null && f.counterpartyOrgId === f.agentOrgId) &&
      f.capitalAtRisk >= MIN_CAPITAL_PER_JOB,
  );
  if (counted.length === 0) return UNRATED;

  const uniqueCounterparties = new Set(counted.map((f) => f.counterparty)).size;
  const totalCapital = counted.reduce((s, f) => s + f.capitalAtRisk, 0n);
  // History span = now − oldest counted job. Seed the min with Infinity (counted is non-empty here),
  // NOT with `now`: seeding with `now` would collapse the span to 0 under clock skew or a stale `now`
  // that predates a real settled history, wrongly forcing UNRATED. Clamp ≥ 0 for a future-dated `now`.
  const oldest = counted.reduce((m, f) => Math.min(m, f.settledAt), Infinity);
  const historySeconds = Math.max(0, opts.now - oldest);

  // Rule 6: UNRATED gate.
  if (
    uniqueCounterparties < MIN_UNIQUE_COUNTERPARTIES ||
    totalCapital < MIN_TOTAL_CAPITAL ||
    historySeconds < MIN_HISTORY_SECONDS
  ) {
    return UNRATED;
  }

  // Rule 2: diversity drives the score, capped at the target breadth (volume cannot farm it).
  const diversityTerm = Math.min(1, uniqueCounterparties / w.diversityTarget);

  const completionRate = counted.filter((f) => f.completed).length / counted.length;

  // Rule 4: capital-weighted mean recency (0.5^(ageDays/90)); recent jobs ≈ 1, a half-life-old ≈ 0.5.
  // Number(capitalAtRisk) below coerces money to double — acceptable HERE only because it feeds the
  // dimensionless SCORE, never a money output (the returned capitalAtRisk stays bigint). Precision
  // degrades past 2^53 base units (~$9B aggregate); the curve is unfrozen calibration, so this is a
  // documented score-fidelity bound, not a money defect.
  let weightedRecency = 0;
  for (const f of counted) {
    const ageDays = Math.max(0, (opts.now - f.settledAt) / SECONDS_PER_DAY);
    const recencyWeight = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
    weightedRecency += recencyWeight * Number(f.capitalAtRisk);
  }
  const recencyTerm = weightedRecency / Number(totalCapital);

  // Rule 5: dispute penalty proportional to disputed value.
  const disputedValue = counted.filter((f) => f.disputed).reduce((s, f) => s + f.capitalAtRisk, 0n);
  const disputeFraction = Number(disputedValue) / Number(totalCapital);

  const score = clamp01(
    w.diversity * diversityTerm +
      w.completion * completionRate +
      w.recency * recencyTerm -
      w.dispute * disputeFraction,
  );

  return { rated: true, score, uniqueCounterparties, capitalAtRisk: totalCapital };
}

/**
 * Source settled-job facts (C-8) for an agent from the cold ledger. A settled spend writes a balanced
 * pair to `spend_events` (debit `agent-float`, credit the vendor); the CREDIT rows are this agent's
 * arms-length jobs — `account` is the counterparty (vendor address), `amount` the capital-at-risk,
 * `settlement_timestamp` the recency clock (events.ts:118-134). Phase-1 vendors are external, so
 * `counterpartyOrgId` is null (no self-loop) and a SETTLED spend `completed`; dispute events arrive via
 * the escrow path, deferred behind SPIKE-01, so `disputed` is false here.
 *
 * Load-bearing invariant: a vendor `destination`/`account` is an on-chain address (0x…/base58) and so
 * never equals the reserved internal-account literals `'agent-float'`/`'treasury'` excluded below — the
 * filter therefore selects exactly the arms-length counterparty credit rows, one per settled payment
 * (recordSettlement writes a single credit row per payment, events.ts:118-134). Enforcing that
 * destinations are real addresses at the recordSettlement boundary is a ledger-layer hardening item.
 */
export async function loadJobFacts(pool: pg.Pool, params: { agentId: string }): Promise<JobFact[]> {
  const { rows } = await pool.query<{
    account: string;
    amount: string;
    org_id: string;
    settled_at: string;
  }>(
    `SELECT account, amount, org_id, EXTRACT(EPOCH FROM settlement_timestamp)::bigint AS settled_at
       FROM spend_events
      WHERE agent_id = $1 AND direction = 'credit' AND account NOT IN ('agent-float', 'treasury')`,
    [params.agentId],
  );
  return rows.map((r) => ({
    counterparty: r.account,
    counterpartyOrgId: null,
    agentOrgId: r.org_id,
    capitalAtRisk: BigInt(r.amount),
    completed: true,
    disputed: false,
    settledAt: Number(r.settled_at),
  }));
}

export interface ReputationDeps {
  pool: pg.Pool;
}

/**
 * Read-side reputation API: load the agent's settled-job facts and recompute the score. Serves
 * Resolution's discovery ranking; NEVER an input to a payment decision (engine-specs-FINAL.md:237-243).
 * The C-9 post to the on-chain ERC-8004 Reputation Registry is deferred (on-chain verdict recording →
 * mainnet governance spec, BUG-35); the recompute + serve IS the Phase-1 deliverable.
 */
export async function getReputation(
  deps: ReputationDeps,
  params: { agentId: string; now: number },
): Promise<ReputationResult> {
  const facts = await loadJobFacts(deps.pool, { agentId: params.agentId });
  return computeReputation(facts, { now: params.now });
}
