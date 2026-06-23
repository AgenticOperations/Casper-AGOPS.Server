import { describe, it, expect } from 'vitest';
import { createCasperRpcSettlementReader } from '../../src/lib/casper/settlement-reader.js';
import type { CasperGuardDecisionRecord } from '../../src/engines/casper-guard/store.js';

const baseDecision = (over: Partial<CasperGuardDecisionRecord> = {}): CasperGuardDecisionRecord =>
  ({
    decisionId: 'cgd_1',
    orgId: 'org_1',
    agentId: 'agt_1',
    actionKind: 'x402-payment',
    network: 'casper:casper-test',
    resourceId: 'svc:x',
    amount: '100',
    assetKind: 'cep18',
    assetRef: 'a'.repeat(64),
    destination: '00' + 'b'.repeat(64),
    outcome: 'ALLOW',
    policyRef: 'p@v1',
    status: 'SIGNED',
    signedHeaderHash: 'sha256:deadbeef',
    txHash: null,
    deployHash: '0x' + 'c'.repeat(64),
    intent: {} as never,
    reconciliationAttempts: [],
    auditAnchors: [],
    ...over,
  }) as unknown as CasperGuardDecisionRecord;

describe('CasperRpcSettlementReader', () => {
  it('reports settled when the deploy is finalized with success', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: true, finalized: true, success: true, txHash: '0xtx' }),
    });
    const r = await reader.read(baseDecision());
    expect(r.status).toBe('settled');
    if (r.status === 'settled') expect(r.txHash).toBe('0xtx');
  });

  it('reports pending when the deploy is not yet finalized', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: true, finalized: false, success: false }),
    });
    expect((await reader.read(baseDecision())).status).toBe('pending');
  });

  it('reports failed when the deploy finalized with an execution error', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: true, finalized: true, success: false, error: 'Out of gas' }),
    });
    expect((await reader.read(baseDecision())).status).toBe('failed');
  });

  it('reports pending when no deploy is found yet (FSM owns expiry separately)', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: false }),
    });
    expect((await reader.read(baseDecision())).status).toBe('pending');
  });

  it('reports pending when the decision carries no deploy/tx hash yet', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => {
        throw new Error('should not be called');
      },
    });
    expect((await reader.read(baseDecision({ deployHash: null, txHash: null }))).status).toBe('pending');
  });
});
