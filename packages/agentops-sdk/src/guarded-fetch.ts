/**
 * @agops-labs/sdk — guarded fetch: a drop-in `fetch` that handles the x402 payment handshake.
 *
 * Without this, every caller hand-rolls the same five steps: call the service, notice the 402,
 * pass the challenge to authorize-x402, rebuild the headers, retry. That boilerplate is identical
 * everywhere and easy to get subtly wrong (a reused idempotency key silently returns the FIRST
 * decision, so a retry loop can appear to succeed while paying once).
 *
 * SECURITY: this changes only WHO writes the retry loop, never where signing happens. No private
 * key, mnemonic, or signer touches this module — the agent presents an `ag_` API key, the server
 * checks policy and signs inside its vault, and a DENY simply never yields a payment header. An
 * agent running this code cannot exceed its cap by editing it, because it never holds the key that
 * would let it pay without asking.
 */

export interface GuardedFetchConfig {
  /** AgentOps proxy base URL, e.g. https://api.agentops.example (no trailing slash). */
  baseUrl: string;
  /** The agent's `ag_` key. Never an `sk_` operator key — this path is agent-scoped. */
  apiKey: string;
  /** The agent this payment is billed to. Must be the agent the apiKey belongs to. */
  agentId: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Generates the per-attempt idempotency key. Defaults to a random one per payment, which is the
   * safe choice: the server collapses repeats of the SAME key onto one decision, so reusing a key
   * across genuinely different payments would silently return a stale decision.
   */
  idempotencyKey?: () => string;
  /** Casper network selector (`x-agentops-network`). Omit to use the server's default. */
  network?: string;
  /** Called with the decision the moment a payment is authorized — useful for logging the audit id. */
  onDecision?: (decision: GuardedDecision) => void;
}

export interface GuardedDecision {
  decisionId: string;
  holdId?: string;
  /** Present only on ALLOW. */
  paymentHeader?: { name: string; value: string };
}

/** Thrown when policy refuses the payment. Carries the reason so callers can branch on it. */
export class PaymentDeniedError extends Error {
  readonly name = 'PaymentDeniedError';
  constructor(
    readonly reason: string,
    readonly decisionId: string | undefined,
    readonly resource: string,
  ) {
    super(`AgentOps denied payment for ${resource}: ${reason}`);
  }
}

/** Thrown when the 402 challenge or the authorize response is not the shape we can act on. */
export class PaymentFlowError extends Error {
  readonly name = 'PaymentFlowError';
  constructor(message: string) {
    super(message);
  }
}

interface AuthorizeResponse {
  outcome?: 'ALLOW' | 'DENY';
  decision_id?: string;
  hold_id?: string;
  reason?: string;
  error?: string;
  payment_header?: { name: string; value: string };
}

function randomIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  // Node 18 without webcrypto exposed, or an exotic runtime. Uniqueness only has to hold within
  // this process's in-flight payments, which this satisfies.
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Returns a `fetch`-shaped function that transparently pays for 402-gated resources.
 *
 * Non-402 responses pass straight through untouched, so this is safe to use as the ONLY fetch in
 * an agent — free endpoints, JSON APIs, and errors all behave exactly as the platform fetch does.
 *
 * ```ts
 * const guardedFetch = createGuardedFetch({ baseUrl, apiKey, agentId });
 * const res = await guardedFetch(SERVICE_URL, { method: 'POST', body });
 * // 402 -> policy check -> signed header -> retry, all handled. `res` is the paid 200.
 * ```
 */
export function createGuardedFetch(config: GuardedFetchConfig): typeof fetch {
  const fetchImpl = config.fetchImpl ?? fetch;
  const nextIdempotencyKey = config.idempotencyKey ?? randomIdempotencyKey;

  return async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;

    // Read the challenge off a clone so the caller could still inspect `first` if we rethrow.
    let challenge: unknown;
    try {
      challenge = await first.clone().json();
    } catch {
      throw new PaymentFlowError('service returned 402 but the body was not JSON payment requirements');
    }

    const resource = resourceLabel(challenge, input);

    const authRes = await fetchImpl(`${config.baseUrl}/v1/casper-guard/authorize-x402`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        ...(config.network ? { 'x-agentops-network': config.network } : {}),
      },
      body: JSON.stringify({
        agent_id: config.agentId,
        idempotency_key: nextIdempotencyKey(),
        payment_required: challenge,
      }),
    });

    let auth: AuthorizeResponse;
    try {
      auth = (await authRes.json()) as AuthorizeResponse;
    } catch {
      throw new PaymentFlowError(`AgentOps authorize returned ${authRes.status} with a non-JSON body`);
    }

    if (auth.outcome === 'DENY') {
      throw new PaymentDeniedError(auth.reason ?? 'denied', auth.decision_id, resource);
    }
    // A transport/auth failure (bad key, tenant mismatch, unconfigured signer) answers with `error`
    // rather than an outcome. Surface it as a flow error, not a denial — the distinction matters:
    // a denial is policy working correctly, this is the call never reaching policy.
    if (auth.outcome !== 'ALLOW') {
      throw new PaymentFlowError(
        `AgentOps authorize failed (${authRes.status}): ${auth.error ?? 'unrecognized response'}`,
      );
    }
    if (!auth.payment_header?.value) {
      throw new PaymentFlowError('AgentOps allowed the payment but returned no payment header');
    }

    config.onDecision?.({
      decisionId: auth.decision_id!,
      ...(auth.hold_id ? { holdId: auth.hold_id } : {}),
      paymentHeader: auth.payment_header,
    });

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set(auth.payment_header.name, auth.payment_header.value);
    if (auth.decision_id) retryHeaders.set('x-guard-decision-id', auth.decision_id);

    return fetchImpl(input, { ...init, headers: retryHeaders });
  };
}

/** Best-effort human label for the thing being paid for, used in error messages only. */
function resourceLabel(challenge: unknown, input: RequestInfo | URL): string {
  const url = (challenge as { resource?: { url?: unknown } } | null)?.resource?.url;
  if (typeof url === 'string' && url.length > 0) return url;
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return 'resource';
}
