import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorizeCasperGuardIntent,
  resolveCasperGuardTerminalFailure,
  type CasperGuardPolicy,
  type CasperGuardSigner,
} from '../../src/engines/casper-guard/policy.js';
import {
  appendCasperGuardAuditAnchor,
  markCasperGuardDecisionSettled,
  readCasperGuardDecision,
} from '../../src/engines/casper-guard/store.js';
import { normalizeCasperGuardIntent, type CasperGuardIntent } from '../../src/engines/casper-guard/types.js';
import {
  computeCasperGuardDecisionHash,
  reconcileCasperGuardDecision,
  type CasperGuardSettlementReader,
  type GuardRegistryAnchorer,
} from '../../src/engines/casper-guard/reconcile-worker.js';
import { keys } from '../../src/redis/keyspace.js';
import { seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;

beforeAll(async () => {
  stores = await startStores();
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

const allowPolicy: CasperGuardPolicy = {
  policyRef: 'policy_casper_reconcile@v1',
  spendCap: '100',
  perTransactionMax: '100',
  serviceScope: ['svc:casper-paid-api'],
  allowedActions: ['x402-payment'],
  allowedNetworks: ['casper:casper-test'],
  velocityLimitPerHour: 100,
  trade: { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] },
};

function casperX402Intent(amount = '10'): CasperGuardIntent {
  return normalizeCasperGuardIntent({
    kind: 'x402-payment',
    network: 'casper:casper-test',
    resource_id: 'svc:casper-paid-api',
    amount,
    asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
    pay_to: `00${'b'.repeat(64)}`,
    max_timeout_seconds: 900,
    raw_requirement_hash: `sha256:reconcile-${amount}`,
  });
}

async function seedSignedDecision(input: {
  decisionId: string;
  holdId: string;
  idempotencyKey: string;
  amount?: string;
}) {
  if (!stores) throw new Error('stores unavailable');
  const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
  const signer: CasperGuardSigner = {
    kind: 'local-testnet',
    sign: () => Promise.resolve({ signedHeaderHash: `sha256:${input.decisionId}` }),
  };
  await authorizeCasperGuardIntent(
    { pool: stores.pool, redis: stores.redis, signer },
    {
      decisionId: input.decisionId,
      holdId: input.holdId,
      idempotencyKey: input.idempotencyKey,
      orgId,
      agentId,
      intent: casperX402Intent(input.amount ?? '10'),
      policy: allowPolicy,
      now: 2_000_000,
    },
  );
  return { agentId, orgId };
}

describe('AgentOps reconciliation and Odra anchoring', () => {
  it('settles a signed x402 decision exactly once and anchors the decision hash', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_settle',
      holdId: 'cgh_reconcile_settle',
      idempotencyKey: 'idem_reconcile_settle',
    });
    const reader: CasperGuardSettlementReader = {
      read: () =>
        Promise.resolve({
          status: 'settled',
          source: 'facilitator',
          txHash: 'casper-tx-1',
          deployHash: 'casper-deploy-1',
          evidence: { receipt: 'accepted' },
        }),
    };
    const anchorer: GuardRegistryAnchorer = {
      anchorDecision: ({ decisionHash }) => Promise.resolve({ txHash: `anchor-${decisionHash.slice(0, 12)}` }),
    };

    const first = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
      { decisionId: 'cgd_reconcile_settle', agentId },
    );
    const second = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
      { decisionId: 'cgd_reconcile_settle', agentId },
    );

    expect(first).toMatchObject({
      decisionId: 'cgd_reconcile_settle',
      status: 'SETTLED',
      settled: true,
      anchored: true,
      anchorStatus: 'anchored',
    });
    // The second reconcile submits nothing new, but the decision IS on-chain from the first call —
    // so it reports anchored:true/already_anchored. Previously this returned anchored:false, which
    // was indistinguishable from "never anchored" despite the proof existing.
    expect(second).toMatchObject({
      decisionId: 'cgd_reconcile_settle',
      status: 'SETTLED',
      settled: false,
      anchored: true,
      anchorStatus: 'already_anchored',
    });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');

    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_settle');
    expect(persisted).toMatchObject({
      status: 'SETTLED',
      txHash: 'casper-tx-1',
      deployHash: 'casper-deploy-1',
      hold: { status: 'SETTLED' },
      reconciliationAttempts: [{ attemptNumber: 1, source: 'facilitator', status: 'settled' }],
      auditAnchors: [{ anchorKind: 'odra-guard-registry', status: 'confirmed' }],
    });
    expect(persisted?.auditAnchors).toHaveLength(1);
  });

  it('keeps ambiguous Casper reads unresolved and leaves the hold reserved', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_ambiguous',
      holdId: 'cgh_reconcile_ambiguous',
      idempotencyKey: 'idem_reconcile_ambiguous',
    });
    const reader: CasperGuardSettlementReader = {
      read: () =>
        Promise.resolve({
          status: 'ambiguous',
          source: 'casper-rpc',
          evidence: { rpc: 'timeout' },
          errorCode: 'rpc_timeout',
        }),
    };

    const result = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader },
      { decisionId: 'cgd_reconcile_ambiguous', agentId },
    );

    expect(result).toEqual({
      decisionId: 'cgd_reconcile_ambiguous',
      status: 'EXPIRY_CHECK',
      settled: false,
      anchored: false,
      anchorStatus: 'skipped_not_settled',
    });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('10');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_ambiguous');
    expect(persisted).toMatchObject({
      status: 'EXPIRY_CHECK',
      hold: { status: 'RESERVED' },
      reconciliationAttempts: [{ attemptNumber: 1, status: 'ambiguous', errorCode: 'rpc_timeout' }],
      auditAnchors: [],
    });
  });

  it('expires terminal failed reads idempotently and retains reconciliation evidence', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_expired',
      holdId: 'cgh_reconcile_expired',
      idempotencyKey: 'idem_reconcile_expired',
    });
    const reader: CasperGuardSettlementReader = {
      read: () =>
        Promise.resolve({
          status: 'expired',
          source: 'facilitator',
          evidence: { reason: 'nonce_expired' },
          errorCode: 'nonce_expired',
        }),
    };

    const first = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader },
      { decisionId: 'cgd_reconcile_expired', agentId },
    );
    const second = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader },
      { decisionId: 'cgd_reconcile_expired', agentId },
    );

    expect(first).toEqual({ decisionId: 'cgd_reconcile_expired', status: 'EXPIRED', settled: false, anchored: false, anchorStatus: 'skipped_not_settled' });
    expect(second).toEqual({ decisionId: 'cgd_reconcile_expired', status: 'EXPIRED', settled: false, anchored: false, anchorStatus: 'skipped_not_settled' });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_expired');
    expect(persisted).toMatchObject({
      status: 'EXPIRED',
      hold: { status: 'RELEASED' },
      reconciliationAttempts: [{ attemptNumber: 1, status: 'failed', errorCode: 'nonce_expired' }],
    });
    expect(persisted?.reconciliationAttempts).toHaveLength(1);
  });

  it('repairs a previously marked settled decision whose hold cleanup was interrupted', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_repair_settled',
      holdId: 'cgh_reconcile_repair_settled',
      idempotencyKey: 'idem_reconcile_repair_settled',
    });
    await markCasperGuardDecisionSettled(stores.pool, {
      decisionId: 'cgd_reconcile_repair_settled',
      txHash: 'casper-tx-repair',
      deployHash: 'casper-deploy-repair',
    });
    const reader: CasperGuardSettlementReader = {
      read: () => Promise.reject(new Error('settlement reader should not be called for settled repair')),
    };
    const anchorer: GuardRegistryAnchorer = {
      anchorDecision: ({ decisionHash }) => Promise.resolve({ txHash: `anchor-${decisionHash.slice(0, 12)}` }),
    };

    const result = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
      { decisionId: 'cgd_reconcile_repair_settled', agentId },
    );

    expect(result).toEqual({
      decisionId: 'cgd_reconcile_repair_settled',
      status: 'SETTLED',
      settled: true,
      anchored: true,
      anchorStatus: 'anchored',
    });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_repair_settled');
    expect(persisted).toMatchObject({
      status: 'SETTLED',
      hold: { status: 'SETTLED' },
      auditAnchors: [{ anchorKind: 'odra-guard-registry', status: 'confirmed' }],
    });
  });

  it('still settles when the audit anchorer is not configured, reporting anchor_status not_configured', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_no_anchorer',
      holdId: 'cgh_reconcile_no_anchorer',
      idempotencyKey: 'idem_reconcile_no_anchorer',
    });
    const reader: CasperGuardSettlementReader = {
      read: () =>
        Promise.resolve({
          status: 'settled',
          source: 'facilitator',
          txHash: 'casper-tx-no-anchorer',
          deployHash: 'casper-deploy-no-anchorer',
          evidence: { receipt: 'accepted' },
        }),
    };

    /*
     * The payment has already cleared on-chain when the reader reports 'settled'. Refusing to record
     * that because audit anchoring is unconfigured would strand real money movement in an unsettled
     * state — so settlement proceeds and the missing anchor is reported, not thrown.
     */
    const result = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader },
      { decisionId: 'cgd_reconcile_no_anchorer', agentId },
    );
    expect(result).toMatchObject({
      status: 'SETTLED',
      settled: true,
      anchored: false,
      anchorStatus: 'not_configured',
    });
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_no_anchorer');
    expect(persisted).toMatchObject({
      status: 'SETTLED',
      hold: { status: 'SETTLED' },
      reconciliationAttempts: [{ attemptNumber: 1, status: 'settled' }],
      auditAnchors: [],
    });
  });

  it('deduplicates concurrent reconciliation attempts instead of crashing the worker race', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_concurrent',
      holdId: 'cgh_reconcile_concurrent',
      idempotencyKey: 'idem_reconcile_concurrent',
    });
    let reads = 0;
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const reader: CasperGuardSettlementReader = {
      async read() {
        reads += 1;
        if (reads === 2) releaseBarrier();
        await barrier;
        return {
          status: 'ambiguous',
          source: 'casper-rpc',
          evidence: { rpc: 'shared-timeout' },
          errorCode: 'rpc_timeout',
        };
      },
    };

    const results = await Promise.all([
      reconcileCasperGuardDecision(
        { pool: stores.pool, redis: stores.redis, settlementReader: reader },
        { decisionId: 'cgd_reconcile_concurrent', agentId },
      ),
      reconcileCasperGuardDecision(
        { pool: stores.pool, redis: stores.redis, settlementReader: reader },
        { decisionId: 'cgd_reconcile_concurrent', agentId },
      ),
    ]);

    expect(results).toEqual([
      { decisionId: 'cgd_reconcile_concurrent', status: 'EXPIRY_CHECK', settled: false, anchored: false, anchorStatus: 'skipped_not_settled' },
      { decisionId: 'cgd_reconcile_concurrent', status: 'EXPIRY_CHECK', settled: false, anchored: false, anchorStatus: 'skipped_not_settled' },
    ]);
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_concurrent');
    expect(persisted).toMatchObject({
      status: 'EXPIRY_CHECK',
      hold: { status: 'RESERVED' },
    });
    expect(persisted?.reconciliationAttempts).toHaveLength(2);
    expect(persisted?.reconciliationAttempts).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: 'ambiguous', errorCode: 'rpc_timeout' }),
      expect.objectContaining({ attemptNumber: 2, status: 'ambiguous', errorCode: 'rpc_timeout' }),
    ]);
  });

  it('submits one Odra anchor when concurrent settled workers race', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_anchor_race',
      holdId: 'cgh_reconcile_anchor_race',
      idempotencyKey: 'idem_reconcile_anchor_race',
    });
    let reads = 0;
    let releaseReaderBarrier: () => void = () => undefined;
    const readerBarrier = new Promise<void>((resolve) => {
      releaseReaderBarrier = resolve;
    });
    const reader: CasperGuardSettlementReader = {
      async read() {
        reads += 1;
        if (reads === 2) releaseReaderBarrier();
        await readerBarrier;
        return {
          status: 'settled',
          source: 'facilitator',
          txHash: 'casper-tx-anchor-race',
          deployHash: 'casper-deploy-anchor-race',
          evidence: { receipt: 'accepted' },
        };
      },
    };
    let anchorCalls = 0;
    const anchorer: GuardRegistryAnchorer = {
      anchorDecision: ({ decisionHash }) => {
        anchorCalls += 1;
        return Promise.resolve({ txHash: `anchor-${decisionHash.slice(0, 12)}` });
      },
    };

    const results = await Promise.all([
      reconcileCasperGuardDecision(
        { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
        { decisionId: 'cgd_reconcile_anchor_race', agentId },
      ),
      reconcileCasperGuardDecision(
        { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
        { decisionId: 'cgd_reconcile_anchor_race', agentId },
      ),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.decisionId === 'cgd_reconcile_anchor_race')).toBe(true);
    expect(results.every((result) => result.status === 'SETTLED')).toBe(true);
    expect(results.filter((result) => result.settled)).toHaveLength(1);
    expect(results.filter((result) => result.anchored)).toHaveLength(1);
    expect(anchorCalls).toBe(1);
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_anchor_race');
    expect(persisted?.auditAnchors).toHaveLength(1);
    expect(persisted).toMatchObject({
      status: 'SETTLED',
      hold: { status: 'SETTLED' },
      auditAnchors: [{ anchorKind: 'odra-guard-registry', status: 'confirmed' }],
    });
  });

  it('returns the durable terminal state when settled evidence loses an expiry race', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_settled_loses_expiry',
      holdId: 'cgh_reconcile_settled_loses_expiry',
      idempotencyKey: 'idem_reconcile_settled_loses_expiry',
    });
    const reader: CasperGuardSettlementReader = {
      async read() {
        await resolveCasperGuardTerminalFailure(
          { pool: stores!.pool, redis: stores!.redis },
          {
            decisionId: 'cgd_reconcile_settled_loses_expiry',
            agentId,
            status: 'EXPIRED',
          },
        );
        return {
          status: 'settled',
          source: 'facilitator',
          txHash: 'casper-tx-lost-race',
          deployHash: 'casper-deploy-lost-race',
          evidence: { receipt: 'late' },
        };
      },
    };
    const anchorer: GuardRegistryAnchorer = {
      anchorDecision: ({ decisionHash }) => Promise.resolve({ txHash: `anchor-${decisionHash.slice(0, 12)}` }),
    };

    const result = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
      { decisionId: 'cgd_reconcile_settled_loses_expiry', agentId },
    );

    expect(result).toEqual({
      decisionId: 'cgd_reconcile_settled_loses_expiry',
      status: 'EXPIRED',
      settled: false,
      anchored: false,
      anchorStatus: 'skipped_not_settled',
    });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_settled_loses_expiry');
    expect(persisted).toMatchObject({
      status: 'EXPIRED',
      hold: { status: 'RELEASED' },
      reconciliationAttempts: [
        { attemptNumber: 1, status: 'settled' },
      ],
      auditAnchors: [],
    });
  });

  it('retries a stale submitted audit anchor after a worker crash', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId } = await seedSignedDecision({
      decisionId: 'cgd_reconcile_stale_anchor',
      holdId: 'cgh_reconcile_stale_anchor',
      idempotencyKey: 'idem_reconcile_stale_anchor',
    });
    await markCasperGuardDecisionSettled(stores.pool, {
      decisionId: 'cgd_reconcile_stale_anchor',
      txHash: 'casper-tx-stale-anchor',
      deployHash: 'casper-deploy-stale-anchor',
    });
    const settled = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_stale_anchor');
    if (!settled) throw new Error('stale anchor fixture missing settled decision');
    const decisionHash = computeCasperGuardDecisionHash(settled);
    await appendCasperGuardAuditAnchor(stores.pool, {
      anchorId: 'cga_reconcile_stale_anchor',
      decisionId: 'cgd_reconcile_stale_anchor',
      anchorKind: 'odra-guard-registry',
      decisionHash,
      status: 'submitted',
      network: settled.network,
    });
    await stores.pool.query(
      `UPDATE casper_guard_audit_anchors
          SET anchored_at = now() - interval '10 minutes'
        WHERE anchor_id = $1`,
      ['cga_reconcile_stale_anchor'],
    );
    const reader: CasperGuardSettlementReader = {
      read: () => Promise.reject(new Error('settlement reader should not be called for settled anchor retry')),
    };
    let anchorCalls = 0;
    const anchorer: GuardRegistryAnchorer = {
      anchorDecision: ({ decisionHash: hash }) => {
        anchorCalls += 1;
        return Promise.resolve({ txHash: `anchor-${hash.slice(0, 12)}` });
      },
    };

    const result = await reconcileCasperGuardDecision(
      { pool: stores.pool, redis: stores.redis, settlementReader: reader, anchorer },
      { decisionId: 'cgd_reconcile_stale_anchor', agentId },
    );

    expect(result).toEqual({
      decisionId: 'cgd_reconcile_stale_anchor',
      status: 'SETTLED',
      settled: true,
      anchored: true,
      anchorStatus: 'anchored',
    });
    expect(anchorCalls).toBe(1);
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_reconcile_stale_anchor');
    expect(persisted).toMatchObject({
      status: 'SETTLED',
      hold: { status: 'SETTLED' },
      auditAnchors: [{ anchorId: 'cga_reconcile_stale_anchor', status: 'confirmed' }],
    });
  });
});
