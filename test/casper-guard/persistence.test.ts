import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendCasperGuardAuditAnchor,
  appendCasperGuardReconciliationAttempt,
  createCasperGuardDecision,
  createCasperGuardHold,
  readCasperGuardDecision,
} from '../../src/engines/casper-guard/store.js';
import { normalizeCasperGuardIntent } from '../../src/engines/casper-guard/types.js';
import { seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;

beforeAll(async () => {
  stores = await startStores();
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

describe('Casper Guard persistence', () => {
  it('persists decisions, holds, reconciliation attempts, and Odra audit anchors', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const intent = normalizeCasperGuardIntent({
      kind: 'x402-payment',
      network: 'casper:casper-test',
      resource_id: 'svc:casper-paid-api',
      amount: '10',
      asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
      pay_to: `00${'b'.repeat(64)}`,
      max_timeout_seconds: 900,
      raw_requirement_hash: 'sha256:x402-requirements',
    });

    await createCasperGuardDecision(stores.pool, {
      decisionId: 'cgd_test_1',
      idempotencyKey: 'idem_test_1',
      orgId,
      agentId,
      intent,
      status: 'SIGNED',
      outcome: 'ALLOW',
      policyRef: 'policy_test@v1',
      signerKind: 'local-testnet',
      signedHeaderHash: 'sha256:payment-signature',
    });
    await createCasperGuardHold(stores.pool, {
      holdId: 'cgh_test_1',
      decisionId: 'cgd_test_1',
      orgId,
      agentId,
      amount: '10',
      assetKind: 'cep18',
      assetRef: 'a'.repeat(64),
      status: 'RESERVED',
    });
    await appendCasperGuardReconciliationAttempt(stores.pool, {
      decisionId: 'cgd_test_1',
      attemptNumber: 1,
      source: 'facilitator',
      status: 'pending',
      evidence: { facilitator: 'local', payment: 'not-yet-settled' },
    });
    await appendCasperGuardAuditAnchor(stores.pool, {
      anchorId: 'cga_test_1',
      decisionId: 'cgd_test_1',
      anchorKind: 'odra-guard-registry',
      decisionHash: 'sha256:decision',
      status: 'submitted',
      txHash: 'deploy-hash-1',
    });

    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_test_1');
    expect(persisted).toMatchObject({
      decisionId: 'cgd_test_1',
      orgId,
      agentId,
      actionKind: 'x402-payment',
      network: 'casper:casper-test',
      status: 'SIGNED',
      outcome: 'ALLOW',
      policyRef: 'policy_test@v1',
      signedHeaderHash: 'sha256:payment-signature',
      hold: {
        holdId: 'cgh_test_1',
        amount: '10',
        status: 'RESERVED',
      },
      reconciliationAttempts: [
        {
          attemptNumber: 1,
          source: 'facilitator',
          status: 'pending',
          evidence: { facilitator: 'local', payment: 'not-yet-settled' },
        },
      ],
      auditAnchors: [
        {
          anchorId: 'cga_test_1',
          anchorKind: 'odra-guard-registry',
          decisionHash: 'sha256:decision',
          status: 'submitted',
          txHash: 'deploy-hash-1',
        },
      ],
    });
  });

  it('rejects audit-impossible decision states at the database boundary', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const intent = normalizeCasperGuardIntent({
      kind: 'x402-payment',
      network: 'casper:casper-test',
      resource_id: 'svc:casper-paid-api',
      amount: '10',
      asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
      pay_to: `00${'b'.repeat(64)}`,
      max_timeout_seconds: 900,
    });

    await expect(
      createCasperGuardDecision(stores.pool, {
        decisionId: 'cgd_invalid_signed_deny',
        idempotencyKey: 'idem_invalid_signed_deny',
        orgId,
        agentId,
        intent,
        status: 'SIGNED',
        outcome: 'DENY',
        policyRef: 'policy_test@v1',
        signedHeaderHash: 'sha256:impossible',
      }),
    ).rejects.toThrow();

    await expect(
      createCasperGuardDecision(stores.pool, {
        decisionId: 'cgd_invalid_reserved_signature',
        idempotencyKey: 'idem_invalid_reserved_signature',
        orgId,
        agentId,
        intent,
        status: 'RESERVED',
        outcome: 'ALLOW',
        policyRef: 'policy_test@v1',
        signedHeaderHash: 'sha256:too-early',
      }),
    ).rejects.toThrow();
  });
});
