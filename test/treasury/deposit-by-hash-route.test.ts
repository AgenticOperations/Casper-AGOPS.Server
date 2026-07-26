import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startStores, stopStores, buildOracleApp, seedOrgAdmin, type Stores } from '../helpers/oracle-harness.js';
import type { CasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';

const RPC_URL = 'https://rpc.casper-test.example';
const OPERATOR_ACCOUNT_HASH = 'account-hash-0000000000000000000000000000000000000000000000000000000000000000';
const DEPLOY_HASH = 'a'.repeat(64);

/**
 * Gateway whose `deposit()` THROWS — mirroring the real Casper client, where deposit() submits a
 * fresh signed CSPR transfer that can fail (signing / gas / RPC). deposit-by-hash must NOT call it:
 * the funds already arrived on-chain and were verified, so the endpoint only records idempotency.
 */
function throwingDepositGateway(): CasperTreasuryClient {
  return {
    getBalances: vi.fn(async () => ({ available: 5_000_000_000n })),
    deposit: vi.fn(async () => { throw new Error('submitTransfer_failed'); }),
    depositFor: vi.fn(),
    reclaimFor: vi.fn(),
    isFinal: vi.fn(),
  };
}

/** A finalized, successful native-transfer transaction as returned by info_get_transaction. */
function mockFetchSuccess(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        execution_info: { execution_result: { Version2: { error_message: null, transfers: ['transfer-1'] } } },
      },
    }),
  })) as unknown as typeof fetch);
}

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  stores = await startStores();
  if (stores) {
    app = buildOracleApp(stores.pool, stores.redis, undefined, throwingDepositGateway(), {
      CASPER_GUARD_FACILITATOR_RPC_URL: RPC_URL,
      CASPER_OPERATOR_ACCOUNT_HASH: OPERATOR_ACCOUNT_HASH,
    });
  }
}, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });
beforeEach(() => mockFetchSuccess());
afterEach(() => vi.unstubAllGlobals());

describe('POST /v1/treasury/deposit-by-hash', () => {
  it('credits from a verified on-chain transfer without submitting a new transfer', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { sk } = await seedOrgAdmin(stores.pool);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/treasury/deposit-by-hash',
      headers: { authorization: `Bearer ${sk}` },
      payload: { deploy_hash: DEPLOY_HASH, amount: '200000000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ credited: true, already_credited: false, credited_amount: '200000000' });
  });

  it('is idempotent on the deploy hash', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { sk } = await seedOrgAdmin(stores.pool);
    const hash = 'b'.repeat(64);
    const first = await app.inject({
      method: 'POST', url: '/v1/treasury/deposit-by-hash',
      headers: { authorization: `Bearer ${sk}` },
      payload: { deploy_hash: hash, amount: '200000000' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST', url: '/v1/treasury/deposit-by-hash',
      headers: { authorization: `Bearer ${sk}` },
      payload: { deploy_hash: hash, amount: '200000000' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ credited: true, already_credited: true });
  });
});
