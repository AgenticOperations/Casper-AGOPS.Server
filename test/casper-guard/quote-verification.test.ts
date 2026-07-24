import { describe, it, expect } from 'vitest';
import { verifyMinReceivedWithinSlippage } from '../../src/engines/casper-guard/quote-verification.js';

describe('verifyMinReceivedWithinSlippage (D-5⑤, E.2)', () => {
  it('passes when the intent min-received is at or above quote minus allowed slippage', () => {
    // quote = 1000, maxSlippageBps = 100 (1%) -> amountOutMin = 990
    const result = verifyMinReceivedWithinSlippage({
      quotedAmountOut: 1000n,
      maxSlippageBps: 100,
      intentMinReceived: 990n,
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes when the intent min-received is better than the floor', () => {
    const result = verifyMinReceivedWithinSlippage({
      quotedAmountOut: 1000n,
      maxSlippageBps: 100,
      intentMinReceived: 995n,
    });
    expect(result).toEqual({ ok: true });
  });

  it('denies when the intent min-received is worse than quote minus allowed slippage', () => {
    const result = verifyMinReceivedWithinSlippage({
      quotedAmountOut: 1000n,
      maxSlippageBps: 100,
      intentMinReceived: 980n, // worse than the 990 floor
    });
    expect(result).toEqual({ ok: false, amountOutMin: 990n });
  });

  it('handles zero slippage tolerance — min-received must equal the full quote', () => {
    const exact = verifyMinReceivedWithinSlippage({
      quotedAmountOut: 500n,
      maxSlippageBps: 0,
      intentMinReceived: 500n,
    });
    expect(exact).toEqual({ ok: true });

    const short = verifyMinReceivedWithinSlippage({
      quotedAmountOut: 500n,
      maxSlippageBps: 0,
      intentMinReceived: 499n,
    });
    expect(short).toEqual({ ok: false, amountOutMin: 500n });
  });
});
