import { describe, it, expect } from 'vitest';
import {
  composeSettlementReader,
  createCasperRpcSettlementReader,
  createFacilitatorSettlementReader,
} from '../../src/lib/casper/settlement-reader.js';
import type { CasperGuardDecisionRecord } from '../../src/engines/casper-guard/store.js';
import type { CasperFacilitator } from '../../src/lib/casper/facilitator.js';

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

// Minimal fake facilitator
function makeFacilitator(result: Awaited<ReturnType<CasperFacilitator['settle']>>): CasperFacilitator {
  return {
    verify: async () => ({ isValid: true }),
    settle: async () => result,
  };
}

// Valid base64url-encoded x402 PaymentPayload — matches the format produced by @make-software/casper-x402
// and decoded by decodeCasperX402PaymentHeader → decodePaymentSignatureHeader from @x402/core/http.
const fakeHeader = Buffer.from(JSON.stringify({
  x402Version: 1,
  accepted: { scheme: 'exact', network: 'casper:casper-test', amount: '2000000000' },
  payload: {},
  extensions: {},
})).toString('base64url');

// Decision with no deploy hash (needs facilitator settlement)
const unsettledDecision = baseDecision({ deployHash: null, txHash: null, signedHeaderValue: fakeHeader });

describe('createFacilitatorSettlementReader', () => {
  it('calls facilitator.settle and returns settled with deploy hash on success', async () => {
    const fac = makeFacilitator({ success: true, txHash: 'deadbeef01' });
    const rpcReader = { getDeploy: async () => ({ found: true, finalized: true, success: true, txHash: 'deadbeef01' }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const r = await reader.read(unsettledDecision);
    expect(r.status).toBe('settled');
    if (r.status === 'settled') {
      expect(r.deployHash).toBe('deadbeef01');
      expect(r.source).toBe('facilitator');
    }
  });

  it('returns failed when facilitator.settle reports failure', async () => {
    const fac = makeFacilitator({ success: false, reason: 'invalid_signature' });
    const rpcReader = { getDeploy: async () => { throw new Error('should not be called'); } };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const r = await reader.read(unsettledDecision);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.errorCode).toBe('invalid_signature');
  });

  it('skips facilitator and delegates to RPC reader when deploy hash is already set', async () => {
    const fac = makeFacilitator({ success: false, reason: 'should_not_be_called' });
    fac.settle = async () => { throw new Error('facilitator should not be called'); };
    const rpcReader = { getDeploy: async () => ({ found: true, finalized: true, success: true, txHash: '0xtx' }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    // baseDecision() has deployHash set
    const r = await reader.read(baseDecision());
    expect(r.status).toBe('settled');
    expect(r.source).toBe('casper-rpc');
  });

  it('returns failed (not throws) when facilitator.settle throws', async () => {
    const fac: CasperFacilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => { throw new Error('network_error'); },
    };
    const rpcReader = { getDeploy: async () => ({ found: false }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const r = await reader.read(unsettledDecision);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.errorCode).toBe('facilitator_error');
  });

  it('returns failed with facilitator_no_header when signedHeaderValue is missing', async () => {
    const fac = makeFacilitator({ success: true, txHash: 'deadbeef01' });
    const rpcReader = { getDeploy: async () => ({ found: false }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const noHeaderDecision = baseDecision({ deployHash: null, txHash: null });
    const r = await reader.read(noHeaderDecision);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.errorCode).toBe('facilitator_no_header');
  });

  it('skips facilitator for non-x402 decisions (casper-deploy uses RPC only)', async () => {
    const fac: CasperFacilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => { throw new Error('should not be called for casper-deploy'); },
    };
    const rpcReader = { getDeploy: async () => ({ found: false }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const deployDecision = baseDecision({ actionKind: 'casper-deploy' as never, deployHash: null, txHash: null, signedHeaderValue: fakeHeader });
    const r = await reader.read(deployDecision);
    // Falls through to RPC reader, no deploy hash → pending
    expect(r.status).toBe('pending');
    expect(r.source).toBe('casper-rpc');
  });
});

describe('composeSettlementReader (live primary, body fallback)', () => {
  it('uses the live reader result when it is conclusive (settled)', async () => {
    const live = {
      read: async () => ({ status: 'settled' as const, source: 'casper-rpc' as const, evidence: {}, txHash: '0xtx' }),
    };
    const reader = composeSettlementReader(live, () => ({
      status: 'pending' as const,
      source: 'facilitator' as const,
      evidence: {},
    }));
    expect((await reader.read({} as never)).status).toBe('settled');
  });

  it('uses the live reader result when it is conclusive (failed)', async () => {
    const live = {
      read: async () => ({
        status: 'failed' as const,
        source: 'casper-rpc' as const,
        evidence: {},
        errorCode: 'execution_error',
      }),
    };
    const reader = composeSettlementReader(live, () => ({
      status: 'settled' as const,
      source: 'operator-wallet' as const,
      evidence: {},
      txHash: '0xshouldnotwin',
    }));
    expect((await reader.read({} as never)).status).toBe('failed');
  });

  it('falls back to the body settlement when the live read is pending', async () => {
    const live = {
      read: async () => ({
        status: 'pending' as const,
        source: 'casper-rpc' as const,
        evidence: {},
        errorCode: null,
      }),
    };
    const reader = composeSettlementReader(live, () => ({
      status: 'settled' as const,
      source: 'operator-wallet' as const,
      evidence: { manual: true },
      txHash: '0xmanual',
    }));
    const r = await reader.read({} as never);
    expect(r.status).toBe('settled');
    if (r.status === 'settled') expect(r.source).toBe('operator-wallet');
  });

  it('falls back to the body settlement when the live read is ambiguous', async () => {
    const live = {
      read: async () => ({
        status: 'ambiguous' as const,
        source: 'casper-rpc' as const,
        evidence: {},
        errorCode: null,
      }),
    };
    const reader = composeSettlementReader(live, () => ({
      status: 'pending' as const,
      source: 'facilitator' as const,
      evidence: { from: 'body' },
    }));
    const r = await reader.read({} as never);
    expect(r.status).toBe('pending');
    if (r.status === 'pending') expect(r.source).toBe('facilitator');
  });
});
