/**
 * The typed cross-engine contracts (C-1 .. C-12 in 03-technical-specification.md §3).
 *
 * These are the *edges* between engines: the only shapes that cross an engine
 * boundary. Defining them once, here, keeps every engine honest about what it
 * receives and emits, and gives tests a single vocabulary. Behaviour lives in the
 * engines; this module is types only.
 */

// ── Domain primitives ──────────────────────────────────────────────────────────

/**
 * USDC amount in base units (6 decimals). Always an integer bigint, never a float:
 * money is never represented in a type that can lose a cent to rounding.
 */
export type UsdcBaseUnits = bigint;

export type OrgId = string; // `org_…`
export type AgentId = string; // internal `agt_…`, bound to org_id, immutable
export type PaymentId = string;
export type PolicyId = string; // immutable `policy_…@vN`
export type ResourceId = string; // canonicalized `accepts.resource`

/** Rail divergence is the only place EVM and Solana differ (doc 02 §4.1, doc 03 §7). */
export type Rail =
  | { scheme: 'raw-x402'; chain: 'arc' | 'solana' }
  | { scheme: 'circle-nano'; chain: 'arc' };

/** AgentOps hackathon rails are isolated from the canonical AgentOps Arc/Solana ledger. */
export type CasperGuardRail =
  | { scheme: 'casper-x402'; network: 'casper:casper-test' | 'casper:casper' }
  | { scheme: 'cspr-trade'; network: 'casper:casper-test' | 'casper:casper' }
  | { scheme: 'casper-deploy'; network: 'casper:casper-test' | 'casper:casper' }
  | { scheme: 'evm-transfer'; network: 'evm:sepolia' | 'evm:base-sepolia' };

export type CasperGuardActionKind = 'x402-payment' | 'cspr-trade' | 'casper-deploy' | 'evm-transfer';
export type SpendRailPermission = Rail['scheme'] | CasperGuardRail['scheme'];

export type CasperGuardAsset =
  | { kind: 'cep18'; packageHash: string; name: string; version: string }
  | { kind: 'native'; symbol: 'CSPR' }
  | { kind: 'native-eth'; symbol: 'ETH' }
  | { kind: 'erc20'; address: string; name: string; decimals: number };

/** Payment-state FSM. Holds are permanent through BROADCASTING until on-chain resolution. */
export type PaymentState =
  | 'QUOTED'
  | 'RESERVED'
  | 'SIGNED'
  | 'BROADCASTING'
  | 'EXPIRY_CHECK'
  | 'SETTLED'
  | 'FAILED_TERMINAL'
  | 'EXPIRED';

/** Structured deny reasons. The dashboard maps each to human copy (doc 05 §10). */
export type DenyReason =
  | 'spend_cap_exceeded'
  | 'allocation_exceeded'
  | 'per_transaction_max_exceeded'
  | 'velocity_exceeded'
  | 'service_not_allowed'
  | 'rail_not_permitted'
  | 'org_suspended'
  /** A `depositFor` arrived inside the AllocationPolicy per-agent cooldown window — P3-B (engine-specs:128). */
  | 'allocation_cooldown'
  /**
   * The org's REAL deposited treasury balance cannot cover this agent-float allocation. Distinct from
   * `allocation_exceeded`, which is the POLICY budget dial: this one means the money does not exist.
   * An org that has never deposited into the parent treasury can fund no agent float at all.
   */
  | 'treasury_insufficient_funds'
  /** The vendor domain did not publish (or did not match) this payTo — E7 Domain Binding, BUG-17. */
  | 'destination_unverified';

// ── C-2 / C-3: parsed quote (Oracle → Resolution → P3-A) ────────────────────────

export interface Quote {
  resourceId: ResourceId;
  amount: UsdcBaseUnits;
  asset: 'USDC';
  rail: Rail;
  /** Pay-to address (EVM 0x… or Solana base58), validated per rail at the seam. */
  destination: string;
  /**
   * The EIP-712 verifyingContract (C-3). raw x402 = the token itself (`accepts.asset`), whose
   * domain is resolved via the EIP-5267 ladder at sign; circle-nano = the Gateway contract from
   * `accepts.extra.verifyingContract`. This is agent-asserted. The {@link destination} (payTo) is
   * bound to the vendor domain by the E7 Domain Binding Verifier (M6.L1, BUG-17) — a mismatch is
   * `destination_unverified`. The *token* allowlist is a designed-for harden item; today the EIP-5267
   * ladder already fails closed (`UnsupportedTokenError`) on a token whose domain cannot be resolved.
   */
  verifyingContract: string;
  /**
   * The x402 wire `scheme`/`network` from the chosen `accepts` entry, echoed VERBATIM into the
   * X-PAYMENT envelope the agent re-submits. The server advertised these; we never reconstruct them
   * from {@link rail} (e.g. Circle's scheme string is not our internal rail name). `rail` drives our
   * routing + policy; these two are the opaque wire values the facilitator validates against.
   */
  x402Scheme: string;
  x402Network: string;
  /**
   * The vendor host the agent called to receive this 402 (from `request_context.url`). The E7 Domain
   * Binding Verifier (M6.L1, BUG-17) fetches `https://{originHost}/.well-known/agentops.json` and
   * requires the published address to match {@link destination}; else the spend is DENIED
   * (`destination_unverified`). Empty string when the URL was unparseable → fail-closed deny.
   */
  originHost: string;
  /** Unix seconds. raw x402 = now + maxTimeoutSeconds; circle-nano = now + 3d. */
  validBefore: number;
}

// ── C-1: compiled effective policy blob (Control → Enforcement) ─────────────────

export interface SpendPolicy {
  spendCap: UsdcBaseUnits;
  perTransactionMax: UsdcBaseUnits;
  serviceScope: ResourceId[]; // ALLOWLIST
  railPermission: SpendRailPermission[];
  velocityLimitPerHour: number;
}

export interface AllocationPolicy {
  totalBudget: UsdcBaseUnits; // the master loss-dial
  perAgentMax: UsdcBaseUnits;
  cooldownSeconds: number;
  allowedDestinations: string[];
}

export interface EffectivePolicy {
  agentId: AgentId;
  orgId: OrgId;
  policyId: PolicyId;
  /** Monotonic per-org epoch; P3-A rejects a stale-epoch cache (NFR-03). */
  policyEpoch: number;
  spend: SpendPolicy;
  allocation: AllocationPolicy;
}

// ── C-4: sign request (P3 → Custody, KMS < 10ms) ────────────────────────────────

export interface SignRequest {
  paymentId: PaymentId;
  agentId: AgentId;
  rail: Rail;
  quote: Quote;
  /** External spend always signs from the agent-float role, never treasury. */
  signerRole: 'agent-float';
}

// ── C-5: ledger events (P3 → Ledger). Dual timestamps per NFR-01. ───────────────

export interface EventTimestamps {
  /** When the originating action occurred (request time). */
  occurredAt: string; // ISO-8601
  /** When the ledger durably recorded it. */
  recordedAt: string; // ISO-8601
}

export interface SpendEvent {
  paymentId: PaymentId;
  agentId: AgentId;
  orgId: OrgId;
  amount: UsdcBaseUnits;
  resourceId: ResourceId;
  state: PaymentState;
  timestamps: EventTimestamps;
}

export interface AllocationEvent {
  agentId: AgentId;
  orgId: OrgId;
  amount: UsdcBaseUnits;
  kind: 'depositFor' | 'topup' | 'teardown';
  timestamps: EventTimestamps;
}

// ── C-8: settled-job fact (Ledger P4 + E7 escrow resolver → Identity 7) ──────────

/**
 * One settled job feeding the read-side reputation compute (engine-specs-FINAL.md:58, :229). The
 * rated agent is the payer; {@link counterparty} is the payee. Derived from the cold ledger's
 * `spend_events` (and, once SPIKE-01 clears, escrow resolution events). Reputation is read-side and
 * NEVER gates a policy-valid payment (engine-specs-FINAL.md:237-243), so this contract carries no
 * hot-path obligation.
 */
export interface JobFact {
  /** The payee identity — a vendor address or peer agent id. The unit of counterparty diversity
   *  (anti-wash-trading rule 2: breadth of distinct counterparties, not volume). */
  counterparty: string;
  /** The payee's agentOps org when the payee is an agentOps-managed agent; null for an external
   *  vendor. Self-loop exclusion (rule 1): a fact is dropped iff this equals {@link agentOrgId}. */
  counterpartyOrgId: OrgId | null;
  /** The rated agent's org (the payer side). */
  agentOrgId: OrgId;
  /** Capital at risk for this job, base units. Dust (< $0.10) / sub-$1 jobs do not count (rule 3). */
  capitalAtRisk: UsdcBaseUnits;
  completed: boolean;
  disputed: boolean;
  /** Unix seconds the job settled — the recency clock (rule 4, 90-day half-life). */
  settledAt: number;
}

/**
 * Read-side reputation result (the ERC-8004 Reputation Registry value, engine-specs-FINAL.md:227,229).
 * Serves Resolution's discovery ranking; NEVER an input to a payment decision. `UNRATED` is the
 * deny-of-trust default for new agents (rule 6) — it is NOT a payment deny.
 */
export type ReputationResult =
  | { rated: false; status: 'UNRATED' }
  | {
      rated: true;
      /** Dimensionless trust score in [0,1]; NOT money — higher = more trustworthy. */
      score: number;
      uniqueCounterparties: number;
      /** Total counted capital-at-risk, base units (stays bigint; never a float). */
      capitalAtRisk: UsdcBaseUnits;
    };

// ── The authorize decision (E9 result; observed by E8 via the stream, C-10) ─────

export type AuthorizeDecision =
  | { outcome: 'ALLOW'; paymentId: PaymentId; xPaymentHeader: string }
  | { outcome: 'DENY'; reason: DenyReason };

/**
 * C-10 (engine-specs-FINAL.md:60,252) — the read-side telemetry COPY of one authorize decision,
 * consumed by Monitoring (E8). It carries decision METADATA only: by construction there is no
 * signature or X-PAYMENT field, so raw signature bytes can never reach observability (BUG-31,
 * policy-engine-FINAL.md:210). `amount` is a base-units string (never a float, never a wire bigint).
 * Monitoring holds no authoritative state — this is a rebuildable copy; the durable record is the
 * P4 `payment_events` audit row (engine-specs-FINAL.md:262).
 */
export interface DecisionTelemetry {
  paymentId: string;
  agentId: AgentId;
  /** Human-readable agent name, if known at emit time. Omitted when unnamed. */
  agentName?: string;
  orgId: OrgId;
  outcome: 'ALLOW' | 'DENY' | 'DUPLICATE' | 'SETTLED' | 'FAILED_TERMINAL' | 'EXPIRED';
  reason?: DenyReason;
  /** Hold disposition for outcomes that had a fund hold (ALLOW that later failed/expired). */
  holdStatus?: 'RESERVED' | 'SETTLED' | 'RELEASED';
  /** On-chain tx/deploy hash, present when outcome=SETTLED. */
  txHash?: string;
  railScheme: string;
  railChain: string;
  resourceId: string;
  amount: string;
  ts: number;
}
