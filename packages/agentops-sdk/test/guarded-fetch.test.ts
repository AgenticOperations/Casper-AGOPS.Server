import { describe, it, expect, vi } from 'vitest';
import { createGuardedFetch, PaymentDeniedError, PaymentFlowError } from '../src/guarded-fetch.js';

const BASE_URL = 'https://agentops.example';
const SERVICE = 'https://svc.example/risk-oracle/score';

const CHALLENGE = {
  x402Version: 2,
  resource: { url: 'svc:risk-oracle' },
  accepts: [{ scheme: 'exact', network: 'casper:casper-test', amount: '3000000000' }],
};

const ALLOW = {
  outcome: 'ALLOW',
  decision_id: 'cgd_1',
  hold_id: 'cgh_1',
  payment_header: { name: 'PAYMENT-SIGNATURE', value: 'sig_abc' },
};

/** Responses are consumed in order; the last one repeats if the code calls more times than expected. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const res = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    const make = () =>
      ({
        status: res.status,
        ok: res.status < 400,
        json: async () => res.body,
        clone: make,
      }) as unknown as Response;
    return make();
  });
}

const config = (fetchImpl: ReturnType<typeof fakeFetch>) => ({
  baseUrl: BASE_URL,
  apiKey: 'ag_live_abc',
  agentId: 'agt_1',
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

describe('createGuardedFetch — pass-through', () => {
  it('returns a non-402 response untouched and never calls the proxy', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { free: true } }]);
    const guarded = createGuardedFetch(config(fetchImpl));

    const res = await guarded(SERVICE);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ free: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes a 500 through rather than treating it as a payment problem', async () => {
    const fetchImpl = fakeFetch([{ status: 500, body: { error: 'boom' } }]);
    const guarded = createGuardedFetch(config(fetchImpl));

    expect((await guarded(SERVICE)).status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createGuardedFetch — the 402 handshake', () => {
  it('pays a 402 and returns the retried 200, attaching the signed header + decision id', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 200, body: ALLOW },
      { status: 200, body: { risk_score: 30 } },
    ]);
    const guarded = createGuardedFetch(config(fetchImpl));

    const res = await guarded(SERVICE, { method: 'POST', headers: { 'content-type': 'application/json' } });

    expect(await res.json()).toEqual({ risk_score: 30 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // Call 2 is the authorize: agent-scoped bearer, the challenge forwarded verbatim.
    const [authUrl, authInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(authUrl).toBe(`${BASE_URL}/v1/casper-guard/authorize-x402`);
    expect((authInit.headers as Record<string, string>).authorization).toBe('Bearer ag_live_abc');
    const sent = JSON.parse(authInit.body as string);
    expect(sent.agent_id).toBe('agt_1');
    expect(sent.payment_required).toEqual(CHALLENGE);
    expect(typeof sent.idempotency_key).toBe('string');
    expect(sent.idempotency_key.length).toBeGreaterThan(0);

    // Call 3 is the paid retry: original method/headers preserved, payment headers added.
    const [retryUrl, retryInit] = fetchImpl.mock.calls[2] as [string, RequestInit];
    expect(retryUrl).toBe(SERVICE);
    expect(retryInit.method).toBe('POST');
    const retryHeaders = retryInit.headers as Headers;
    expect(retryHeaders.get('PAYMENT-SIGNATURE')).toBe('sig_abc');
    expect(retryHeaders.get('x-guard-decision-id')).toBe('cgd_1');
    expect(retryHeaders.get('content-type')).toBe('application/json');
  });

  it('reports the decision through onDecision so callers can log the audit id', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 200, body: ALLOW },
      { status: 200, body: {} },
    ]);
    const seen: string[] = [];
    const guarded = createGuardedFetch({ ...config(fetchImpl), onDecision: (d) => seen.push(d.decisionId) });

    await guarded(SERVICE);

    expect(seen).toEqual(['cgd_1']);
  });

  it('sends a fresh idempotency key per payment so repeat calls are not collapsed onto one decision', async () => {
    // Two full handshakes back to back, so the fixture must replay the 402 for the second call.
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 200, body: ALLOW },
      { status: 200, body: {} },
      { status: 402, body: CHALLENGE },
      { status: 200, body: ALLOW },
      { status: 200, body: {} },
    ]);
    const guarded = createGuardedFetch(config(fetchImpl));

    await guarded(SERVICE);
    await guarded(SERVICE);

    const first = JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string);
    const second = JSON.parse((fetchImpl.mock.calls[4] as [string, RequestInit])[1].body as string);
    expect(first.idempotency_key).not.toBe(second.idempotency_key);
  });

  it('forwards the network selector header when configured', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 200, body: ALLOW },
      { status: 200, body: {} },
    ]);
    const guarded = createGuardedFetch({ ...config(fetchImpl), network: 'casper:casper' });

    await guarded(SERVICE);

    const [, authInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((authInit.headers as Record<string, string>)['x-agentops-network']).toBe('casper:casper');
  });
});

describe('createGuardedFetch — refusals', () => {
  it('throws PaymentDeniedError carrying the policy reason, and never retries the service', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 403, body: { outcome: 'DENY', decision_id: 'cgd_2', reason: 'spend_cap_exceeded' } },
    ]);
    const guarded = createGuardedFetch(config(fetchImpl));

    await expect(guarded(SERVICE)).rejects.toBeInstanceOf(PaymentDeniedError);
    // Two calls only: the 402 and the denial. The service was never paid or re-hit.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('exposes reason + decisionId on the denial so callers can branch without string parsing', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 403, body: { outcome: 'DENY', decision_id: 'cgd_3', reason: 'velocity_exceeded' } },
    ]);
    const guarded = createGuardedFetch(config(fetchImpl));

    await expect(guarded(SERVICE)).rejects.toMatchObject({
      reason: 'velocity_exceeded',
      decisionId: 'cgd_3',
      resource: 'svc:risk-oracle',
    });
  });

  it('distinguishes an auth/transport failure from a policy denial', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 403, body: { error: 'tenant_mismatch' } },
    ]);
    const guarded = createGuardedFetch(config(fetchImpl));

    const err = await guarded(SERVICE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentFlowError);
    expect(err).not.toBeInstanceOf(PaymentDeniedError);
    expect((err as Error).message).toContain('tenant_mismatch');
  });

  it('throws when ALLOW arrives without a payment header rather than silently retrying unpaid', async () => {
    const fetchImpl = fakeFetch([
      { status: 402, body: CHALLENGE },
      { status: 200, body: { outcome: 'ALLOW', decision_id: 'cgd_4' } },
    ]);
    const guarded = createGuardedFetch(config(fetchImpl));

    await expect(guarded(SERVICE)).rejects.toBeInstanceOf(PaymentFlowError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when the 402 body is not JSON payment requirements', async () => {
    const fetchImpl = vi.fn(async () => {
      const make = () =>
        ({
          status: 402,
          ok: false,
          json: async () => {
            throw new Error('not json');
          },
          clone: make,
        }) as unknown as Response;
      return make();
    });
    const guarded = createGuardedFetch(config(fetchImpl as never));

    await expect(guarded(SERVICE)).rejects.toBeInstanceOf(PaymentFlowError);
  });
});
