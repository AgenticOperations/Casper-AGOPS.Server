import type { GatewayTransport } from './gateway.js';

/**
 * The REAL (credential-gated) implementation of THE single Circle Gateway boundary (gateway.ts).
 * Selected over {@link createStubTransport} at boot only when a CIRCLE_API_KEY is present (server.ts) —
 * an absent key falls back to the stub, so we NEVER silently pretend to be live. This transport is
 * GENERIC: it issues whatever `{method, path, body}` GatewayClient already constructs, so no Circle
 * endpoint SHAPE is invented here (the path → live Circle API reconciliation is a documented cred-drop
 * step, not this layer's concern).
 *
 * Invariants:
 *   - Bearer auth on every call; `content-type: application/json` only when there is a body.
 *   - Money crosses the boundary as a base-unit STRING — the body is serialized as-is, the response is
 *     JSON-parsed and handed back untouched (NEVER Number()/parseInt(), which would lose precision).
 *   - A non-2xx throws a typed {@link GatewayHttpError} carrying status + path. The apiKey is NEVER
 *     serialized into the error (no header echo, no body echo) so a thrown stack can be logged safely.
 */

/** Typed transport failure for a non-2xx Circle response. Carries status + path; never the apiKey. */
export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`circle gateway request failed: ${status} ${path}`);
    this.name = 'GatewayHttpError';
  }
}

export interface HttpTransportConfig {
  /** e.g. https://api.circle.com — no trailing slash; concatenated with the GatewayClient path verbatim. */
  apiBase: string;
  /** Circle API key. Sent as `Authorization: Bearer ${apiKey}`. NEVER logged or put in an error. */
  apiKey: string;
  /** Injectable for tests; defaults to the global fetch (Node 20+ has it built in). */
  fetchImpl?: typeof fetch;
}

export function createHttpTransport(config: HttpTransportConfig): GatewayTransport {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      const hasBody = req.body !== undefined;
      // Auth on every call. content-type only when a body is actually sent (a GET carries neither).
      const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` };
      if (hasBody) headers['content-type'] = 'application/json';

      const res = await fetchImpl(`${config.apiBase}${req.path}`, {
        method: req.method,
        headers,
        // The body is serialized as-is: base-unit money STRINGS pass through untouched (no float coercion).
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      });

      // Fail-loud on non-2xx. The error carries ONLY status + path — never the apiKey or the auth header.
      if (!res.ok) throw new GatewayHttpError(res.status, req.path);

      // JSON-parse and hand back untouched. Consumers that expect base-unit strings (balances) get the
      // string straight off the wire — this layer does not coerce numbers.
      return (await res.json()) as T;
    },
  };
}
