import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import { buildOracleApp } from '../helpers/oracle-harness.js';

/**
 * Task 7 (network toggle) — treasury deposit-intents are stamped and read back by the request
 * network. A deposit-intent created under the mainnet header must NOT be visible when verifying
 * under the (default) testnet header, and vice-versa. Absent header behaves as testnet (today).
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

async function createIntent(input: {
  app: FastifyInstance;
  adminKey: string;
  network?: string;
}): Promise<{ refId: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${input.adminKey}` };
  if (input.network) headers['x-agentops-network'] = input.network;
  const res = await input.app.inject({
    method: 'POST',
    url: '/v1/treasury/deposit-intent',
    headers,
    payload: { expected_amount: '100' },
  });
  expect(res.statusCode).toBe(200);
  return { refId: res.json<{ ref_id: string }>().ref_id };
}

describe('treasury deposit-intents scoped by request network', () => {
  it('stamps the intent with the request network and fences verify-deposit across networks', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { adminKey } = await seedAgent(stores.pool, stores.redis, 100);

    // Create an intent on mainnet.
    const { refId } = await createIntent({ app, adminKey, network: 'casper:casper' });

    // The row must be stamped mainnet.
    const row = await stores.pool.query<{ network: string }>(
      'SELECT network FROM treasury_deposit_intents WHERE ref_id = $1',
      [refId],
    );
    expect(row.rows[0]?.network).toBe('casper:casper');

    // Verifying that same ref under the TESTNET (default) header must not find it — cross-network fence.
    const testnetVerify = await app.inject({
      method: 'POST',
      url: '/v1/treasury/verify-deposit',
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { ref_id: refId },
    });
    expect(testnetVerify.statusCode).toBe(404);
    expect(testnetVerify.json()).toMatchObject({ error: 'intent_not_found' });
  });

  it('defaults the intent to testnet when no network header is sent', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    const { refId } = await createIntent({ app, adminKey });
    const row = await stores.pool.query<{ network: string }>(
      'SELECT network FROM treasury_deposit_intents WHERE ref_id = $1',
      [refId],
    );
    expect(row.rows[0]?.network).toBe('casper:casper-test');
  });

  it('rejects an invalid network header on intent creation', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { adminKey } = await seedAgent(stores.pool, stores.redis, 100);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/treasury/deposit-intent',
      headers: { authorization: `Bearer ${adminKey}`, 'x-agentops-network': 'casper:bogus' },
      payload: { expected_amount: '100' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_network' });
  });
});
