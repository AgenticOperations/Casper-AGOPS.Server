import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentRequired } from '@x402/core/types';
import type { CasperClientSigner } from '../../src/lib/casper/x402.js';
import { CASPER_X402_HEADER_NAME } from '../../src/lib/casper/x402.js';
import { loadEnv } from '../../src/config/env.js';
import {
  buildCasperGuardDeps,
  createCasperGuardRuntimeSigner,
  type CasperClientSignerProvider,
} from '../../src/config/casper-guard.js';

const { createHeaderSpy } = vi.hoisted(() => ({
  createHeaderSpy: vi.fn(),
}));

vi.mock('../../src/lib/casper/x402.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/casper/x402.js')>();
  return {
    ...actual,
    createCasperX402PaymentHeader: createHeaderSpy,
  };
});

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://agentops:agentops@localhost:5432/agentops',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.arc-testnet.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

const clientSigner = {
  accountAddress: () => `00${'d'.repeat(64)}`,
  publicKey: () => '01public',
  signEIP712: () => Promise.resolve(new Uint8Array(65).fill(7)),
} satisfies CasperClientSigner;

interface CreateHeaderInput {
  signer: CasperClientSigner;
  paymentRequired: PaymentRequired;
}

describe('AgentOps runtime config', () => {
  it('is honest by default: no signer, settlement blocked, Odra blocked', () => {
    const env = loadEnv(BASE_ENV);
    const deps = buildCasperGuardDeps(env);

    expect(deps.signer).toBeUndefined();
    expect(deps.networks).toEqual(['casper:casper-test']);
    expect(deps.liveSettlement).toEqual({
      configured: false,
      reason: 'casper_facilitator_not_configured',
    });
    expect(deps.odra).toEqual({
      configured: false,
      reason: 'odra_contract_not_bound',
    });
    expect(deps.trade).toEqual({ maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] });
  });

  it('flips live_settlement to configured:true when a facilitator rpc url is provided', () => {
    const env = loadEnv({ ...BASE_ENV, CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc' });
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement).toEqual({ configured: true });
    expect(typeof deps.settlementReaderFactory).toBe('function');
  });

  it('builds a local testnet signer only when a PEM path is supplied', () => {
    const withoutPem = buildCasperGuardDeps(
      loadEnv({ ...BASE_ENV, CASPER_GUARD_SIGNER_MODE: 'local-testnet' }),
    );
    expect(withoutPem.signer).toBeUndefined();

    const withPem = buildCasperGuardDeps(
      loadEnv({
        ...BASE_ENV,
        CASPER_GUARD_SIGNER_MODE: 'local-testnet',
        CASPER_GUARD_SIGNER_PEM_PATH: '/keys/casper-testnet.pem',
        CASPER_GUARD_NETWORKS: 'casper:casper-test,casper:casper',
      }),
    );
    expect(withPem.signer?.kind).toBe('local-testnet');
    expect(withPem.networks).toEqual(['casper:casper-test', 'casper:casper']);
  });

  it('signs Casper x402 intents through the real Casper x402 header seam', async () => {
    createHeaderSpy.mockResolvedValue({
      headerName: CASPER_X402_HEADER_NAME,
      headerValue: 'payment-header-value',
      headers: { [CASPER_X402_HEADER_NAME]: 'payment-header-value' },
      payload: { x402Version: 2 },
    });
    const getClientSignerSpy = vi.fn(() => Promise.resolve(clientSigner));
    const provider: CasperClientSignerProvider = {
      mode: 'local-testnet',
      getClientSigner: getClientSignerSpy,
    };
    const signer = createCasperGuardRuntimeSigner(provider);

    const signed = await signer.sign({
      decisionId: 'cgd_test',
      intent: {
        kind: 'x402-payment',
        network: 'casper:casper-test',
        resourceId: 'svc:casper-paid-api',
        amount: '12',
        asset: { kind: 'cep18', packageHash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
        destination: `00${'b'.repeat(64)}`,
        maxTimeoutSeconds: 900,
      },
    });

    expect(getClientSignerSpy).toHaveBeenCalledWith({ network: 'casper:casper-test' });
    const firstCall = createHeaderSpy.mock.calls[0] as [CreateHeaderInput] | undefined;
    if (!firstCall) throw new Error('createCasperX402PaymentHeader was not called');
    const paymentRequired = firstCall[0].paymentRequired;
    expect(paymentRequired).toMatchObject({
      x402Version: 2,
      resource: { url: 'svc:casper-paid-api', serviceName: 'AgentOps' },
      accepts: [
        {
          scheme: 'exact',
          network: 'casper:casper-test',
          amount: '12',
          asset: 'a'.repeat(64),
          payTo: `00${'b'.repeat(64)}`,
          maxTimeoutSeconds: 900,
          extra: { name: 'Test CEP18', version: '1' },
        },
      ],
    });
    expect(signed).toEqual({
      signedHeaderHash: `sha256:${createHash('sha256').update('payment-header-value').digest('hex')}`,
      headers: { [CASPER_X402_HEADER_NAME]: 'payment-header-value' },
    });
  });
});
