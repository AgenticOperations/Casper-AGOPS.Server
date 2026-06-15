/**
 * The Redis keyspace, defined once.
 *
 * Every hot-path key is built through these helpers so the schema in
 * `03-technical-specification.md` (§5, §8) has exactly one source of truth and the
 * keys in code match the keys in the spec, the tests, and the runbooks.
 *
 * Spend windows are hold-inclusive (BUG-14): reserved holds count against the cap
 * the moment they are written, not at settlement.
 */

export type SpendWindow = '1h' | '1d' | '7d' | '30d';

export const SPEND_WINDOW_SECONDS: Readonly<Record<SpendWindow, number>> = {
  '1h': 60 * 60,
  '1d': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

export const keys = {
  /** C-1: compiled effective policy blob consumed by Enforcement (P3-A). */
  effectivePolicy: (agentId: string) => `agent:${agentId}:effective_policy`,
  /** Monotonic policy epoch per org (NFR-03 stale-cache guard). */
  policyEpoch: (orgId: string) => `org:${orgId}:policy_epoch`,
  /** Hold-inclusive spend ZSET per agent per window (E4 hot tier). */
  spendWindow: (agentId: string, window: SpendWindow) => `agent:${agentId}:spend:${window}`,
  /** Companion hash paymentId -> base-unit amount, summed across a window's in-range holds (E4). */
  spendAmounts: (agentId: string) => `agent:${agentId}:spend_amounts`,
  /** Sum of currently-reserved (un-settled) holds for an agent. */
  reserved: (agentId: string) => `agent:${agentId}:reserved`,
  /** Set of paymentIds currently contributing to {@link reserved}; cleared on settle/release so
   *  the reserved counter is decremented exactly once per hold (E4 hot tier). */
  reservedHolds: (agentId: string) => `agent:${agentId}:reserved_holds`,
  /** Set of settled paymentIds; release refuses to un-count one of these so a settled spend can
   *  never escape its window (defense-in-depth, not reliant on FSM discipline alone). */
  settledHolds: (agentId: string) => `agent:${agentId}:settled_holds`,
  /** Atomic grant-claim key (NX) on (payment_id, resource_id) — the global dedup store. */
  grantClaim: (paymentId: string, resourceId: string) => `grant:${paymentId}:${resourceId}`,
  /** Per-escrow reserve set (Signature-as-Escrow, E7). */
  escrowReserved: (escrowId: string) => `escrow:${escrowId}:reserved`,
  /** Org-wide kill-switch. Presence => DENY_ALL / ORG_SUSPENDED. */
  denyAll: (orgId: string) => `org:${orgId}:deny_all`,
  /** Domain-binding cache: vendor host -> published payTo (5-min TTL); E7 recipient binding (BUG-17). */
  domainBinding: (host: string) => `domain_binding:${host}`,
  /** Org allocation budget already committed (settled depositFor) — base units (P3-B). */
  allocationCommitted: (orgId: string) => `org:${orgId}:allocation_committed`,
  /** Org allocation budget reserved (in-flight depositFor) — base units; atomic reserve (BUG-19). */
  allocationReserved: (orgId: string) => `org:${orgId}:allocation_reserved`,
  /** Two-phase float counters for an agent (E5/E6). */
  floatConfirmed: (agentId: string) => `agent:${agentId}:float_confirmed`,
  floatPending: (agentId: string) => `agent:${agentId}:float_pending`,
  /** In-flight allocation record (hash): a submitted depositFor/topup awaiting on-chain finality
   *  (E5; written at L2, promoted/recorded at L3). Carries kind, amount, txRef, and PENDING state. */
  allocation: (allocationId: string) => `allocation:${allocationId}`,
  /** Per-agent SET of in-flight (PENDING) allocation ids — the teardown sweep index (E5/L5, BUG-21).
   *  SADD at submit, SREM on promotion/cancel, so teardown can enumerate what is still in flight. */
  pendingAllocations: (agentId: string) => `agent:${agentId}:pending_allocations`,
  /** Settled/consumed base units — a spendable subtrahend in the two-phase float (BUG-29). */
  consumed: (agentId: string) => `agent:${agentId}:consumed`,
  /** Live authorize decision stream consumed by Monitoring -> SSE (E8). */
  authorizeStream: (orgId: string) => `org:${orgId}:authorize_stream`,
  /**
   * In-flight BROADCASTING payment record (hash). Carries the fields EXPIRY_CHECK needs to reconcile a
   * signed authorization to SETTLED/EXPIRED — crucially the CSPRNG nonce, which exists only at sign
   * time (it leaves in the X-PAYMENT) and must be remembered to read its on-chain consumption (E9/L7).
   */
  payment: (paymentId: string) => `payment:${paymentId}`,
} as const;
