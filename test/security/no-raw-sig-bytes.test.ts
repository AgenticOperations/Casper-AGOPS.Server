import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeXPayment } from '../../src/engines/enforcement/x-payment.js';
import {
  startStores,
  stopStores,
  buildOracleApp,
  seedAgent,
  raw402,
  requestContext,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * No raw signature bytes escape the system (doc 01 §6, engine-specs-FINAL.md telemetry rule). The
 * signature exists ONLY inside the opaque base64url X-PAYMENT the agent re-submits; it must never
 * appear as raw hex in the response body, and the X-PAYMENT must be redacted out of the logs.
 * Requires Docker; skips when none is available.
 */

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
const logLines: string[] = [];

beforeAll(async () => {
  stores = await startStores();
  if (stores) {
    app = buildOracleApp(stores.pool, stores.redis, {
      write: (msg: string) => {
        logLines.push(msg);
      },
    });
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

describe('POST /v1/payment/authorize — no raw signature bytes in response or logs', () => {
  it('carries the signature only inside the opaque X-PAYMENT, never as raw hex; logs redact it', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ payment_id: string; x_payment: string; signature?: unknown }>();
    expect(body.signature).toBeUndefined();

    // The raw signature hex lives only inside the decoded (base64url) envelope.
    const sigHex = decodeXPayment(body.x_payment).payload.signature;
    expect(sigHex).toMatch(/^0x[0-9a-f]+$/i);

    // It must not appear as plaintext anywhere in the response body string.
    expect(res.body).not.toContain(sigHex);

    // Logs must redact the X-PAYMENT entirely — neither the raw sig hex nor the envelope leak.
    const logs = logLines.join('');
    expect(logs).toContain('authorize.decision'); // the decision was logged …
    expect(logs).toContain('[redacted]'); // … with the X-PAYMENT censored
    expect(logs).not.toContain(sigHex);
    expect(logs).not.toContain(body.x_payment);
  });
});
