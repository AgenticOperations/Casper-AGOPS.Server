import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { recoverTypedDataAddress } from 'viem';
import { decodeXPayment } from '../../src/engines/enforcement/x-payment.js';
import { EIP3009_TYPES } from '../../src/lib/eip712/eip3009.js';
import {
  startStores,
  stopStores,
  buildOracleApp,
  seedAgent,
  raw402,
  requestContext,
  agentFloat,
  CHAIN_ID,
  TOKEN,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * E9 Oracle `POST /v1/payment/authorize` — the hot-path HTTP surface (engine-specs-FINAL.md §E9, the
 * 11-step flow). An authenticated agent posts a real 402; agentOps ALLOWs within the SpendCap and
 * returns an X-PAYMENT whose signature recovers to the agent-float; the same agent cranked past the
 * cap is DENIED `spend_cap_exceeded` with HTTP 403. Requires Docker; skips when none is available.
 */

let stores: Stores | null = null;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

describe('POST /v1/payment/authorize — allow within cap, then deny over cap', () => {
  it('ALLOWs $5 (200, X-PAYMENT recovers to agent-float) then DENIES $12 (403 spend_cap_exceeded)', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    const allow = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });

    expect(allow.statusCode).toBe(200);
    const allowBody = allow.json<{ payment_id: string; x_payment: string }>();
    expect(allowBody.payment_id).toMatch(/^pay_/);
    expect(typeof allowBody.x_payment).toBe('string');

    const decoded = decodeXPayment(allowBody.x_payment);
    expect(decoded.payload.authorization.from).toBe(agentFloat.address);
    expect(decoded.payload.authorization.value).toBe('5000000');
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: TOKEN },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: decoded.payload.authorization.from,
        to: decoded.payload.authorization.to,
        value: BigInt(decoded.payload.authorization.value),
        validAfter: BigInt(decoded.payload.authorization.validAfter),
        validBefore: BigInt(decoded.payload.authorization.validBefore),
        nonce: decoded.payload.authorization.nonce,
      },
      signature: decoded.payload.signature,
    });
    expect(recovered).toBe(agentFloat.address);

    const deny = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(12), request_context: requestContext },
    });

    expect(deny.statusCode).toBe(403);
    expect(deny.json()).toEqual({ error: 'spend_cap_exceeded' });
  });
});
