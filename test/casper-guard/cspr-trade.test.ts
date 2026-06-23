import { describe, it, expect, vi } from 'vitest';
import {
  createCsprTradeExecutor,
  UnavailableCsprTradeClient,
  CsprTradeUnavailableError,
} from '../../src/lib/casper/cspr-trade.js';

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
