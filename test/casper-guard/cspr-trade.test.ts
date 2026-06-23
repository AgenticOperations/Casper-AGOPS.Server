import { describe, it, expect, vi } from 'vitest';
import {
  createCsprTradeExecutor,
  UnavailableCsprTradeClient,
  CsprTradeUnavailableError,
} from '../../src/lib/casper/cspr-trade.js';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { loadEnv } from '../../src/config/env.js';

const policy = { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] };

describe('CsprTradeExecutor', () => {
  it('denies a quote whose slippage exceeds the cap (no submit)', async () => {
    const submit = vi.fn();
    const exec = createCsprTradeExecutor({
      policy,
      client: { quote: async () => ({ slippageBps: 250, riskLabel: 'low', quoteId: 'q1' }), submit },
    });
    const r = await exec.execute({ intent: { pair: 'CSPR/USDC', amount: '100' } });
    expect(r.outcome).toBe('DENY');
    if (r.outcome === 'DENY') expect(r.reason).toBe('slippage_exceeds_cap');
    expect(submit).not.toHaveBeenCalled();
  });

  it('denies a quote whose risk label is not allowlisted (no submit)', async () => {
    const submit = vi.fn();
    const exec = createCsprTradeExecutor({
      policy,
      client: { quote: async () => ({ slippageBps: 10, riskLabel: 'high', quoteId: 'q1' }), submit },
    });
    const r = await exec.execute({ intent: { pair: 'CSPR/USDC', amount: '100' } });
    expect(r.outcome).toBe('DENY');
    if (r.outcome === 'DENY') expect(r.reason).toBe('risk_label_not_allowed');
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits a policy-passing quote and returns the tx hash for reconcile', async () => {
    const exec = createCsprTradeExecutor({
      policy,
      client: {
        quote: async () => ({ slippageBps: 50, riskLabel: 'low', quoteId: 'q1' }),
        submit: async () => ({ txHash: '0xswap', deployHash: '0xdep' }),
      },
    });
    const r = await exec.execute({ intent: { pair: 'CSPR/USDC', amount: '100' } });
    expect(r.outcome).toBe('ALLOW');
    if (r.outcome === 'ALLOW') {
      expect(r.txHash).toBe('0xswap');
      expect(r.deployHash).toBe('0xdep');
    }
  });

  it('UnavailableCsprTradeClient throws a typed error (honest-blocked)', async () => {
    const client = new UnavailableCsprTradeClient();
    await expect(client.quote({ pair: 'CSPR/USDC', amount: '1' })).rejects.toBeInstanceOf(
      CsprTradeUnavailableError,
    );
  });
});

describe('buildCasperGuardDeps trade executor wiring', () => {
  const SCHEMA_MIN = {
    DATABASE_URL: 'postgres://x:y@localhost:5432/z',
    REDIS_URL: 'redis://localhost:6379',
    ARC_RPC_URL: 'https://rpc.example',
    ARC_CHAIN_ID: '5042002',
    ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
    GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  };

  it('always wires a tradeExecutor (honest-blocked by default with UnavailableCsprTradeClient)', () => {
    const env = loadEnv(SCHEMA_MIN as never);
    const deps = buildCasperGuardDeps(env);
    expect(typeof deps.tradeExecutor?.execute).toBe('function');
  });

  it('tradeExecutor rejects with CsprTradeUnavailableError when client is unavailable', async () => {
    const env = loadEnv(SCHEMA_MIN as never);
    const deps = buildCasperGuardDeps(env);
    await expect(
      deps.tradeExecutor!.execute({ intent: { pair: 'CSPR/USDC', amount: '1' } }),
    ).rejects.toBeInstanceOf(CsprTradeUnavailableError);
  });
});
