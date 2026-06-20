import { describe, it, expect } from 'vitest';
import { createHttpTransport, GatewayHttpError } from '../../src/lib/circle/http-transport.js';

/**
 * The real (credential-gated) Circle Gateway transport. Docker-free: `fetch` is injected so every
 * assertion is hermetic. The transport is GENERIC — it issues whatever method/path GatewayClient already
 * uses (no Circle endpoint shapes are invented here). Money crosses the boundary as a base-unit STRING;
 * the transport never Number()s a body. The apiKey is NEVER serialized into a thrown error message.
 */

const API_BASE = 'https://api.circle.test';
const API_KEY = 'sk_test_super_secret_value';

/** A minimal Response stand-in good enough for the transport (status + json()). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('createHttpTransport (real Circle boundary, credential-gated)', () => {
  it('GET sets Bearer auth, no content-type and no body, and parses the ok response', async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(jsonResponse(200, { available: '200000000' }));
    }) as unknown as typeof fetch;

    const transport = createHttpTransport({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const body = await transport.request<{ available: string }>({
      method: 'GET',
      path: '/v1/gateway/balances/org_1',
    });

    expect(seenUrl).toBe(`${API_BASE}/v1/gateway/balances/org_1`);
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    // GET has no body and therefore no content-type.
    expect(seenInit?.body).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();
    expect(seenInit?.method).toBe('GET');
    // Money stays a base-unit STRING across the boundary (never Number()).
    expect(body.available).toBe('200000000');
    expect(typeof body.available).toBe('string');
  });

  it('POST sends a JSON body with content-type and parses the ok response', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seenInit = init;
      return Promise.resolve(jsonResponse(200, { id: 'op_123' }));
    }) as unknown as typeof fetch;

    const transport = createHttpTransport({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });
    const res = await transport.request<{ id: string }>({
      method: 'POST',
      path: '/v1/gateway/deposit',
      body: { orgId: 'org_1', amount: '200000000' },
    });

    const headers = seenInit?.headers as Record<string, string>;
    expect(seenInit?.method).toBe('POST');
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['content-type']).toBe('application/json');
    // The base-unit amount stays a string on the wire — no float coercion.
    expect(seenInit?.body).toBe(JSON.stringify({ orgId: 'org_1', amount: '200000000' }));
    expect(res.id).toBe('op_123');
  });

  it('throws a typed GatewayHttpError on non-2xx WITHOUT leaking the apiKey', async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse(500, { error: 'boom' }))) as unknown as typeof fetch;

    const transport = createHttpTransport({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl });

    const err = await transport
      .request({ method: 'GET', path: '/v1/gateway/balances/org_1' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayHttpError);
    const e = err as GatewayHttpError;
    expect(e.status).toBe(500);
    expect(e.path).toBe('/v1/gateway/balances/org_1');
    // The secret must never appear anywhere in the surfaced error.
    expect(e.message).not.toContain(API_KEY);
    expect(JSON.stringify(e)).not.toContain(API_KEY);
  });

  it('defaults fetchImpl to global fetch when none is injected', () => {
    // Constructs without throwing even though no fetch is injected (uses the global).
    const transport = createHttpTransport({ apiBase: API_BASE, apiKey: API_KEY });
    expect(typeof transport.request).toBe('function');
  });
});
