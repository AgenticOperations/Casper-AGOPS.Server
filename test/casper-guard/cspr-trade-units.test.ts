import { describe, expect, it } from 'vitest';
import {
  wholeTokensFromBaseUnits,
  assertQuoteMatchesRequest,
  CSPR_DECIMALS,
} from '../../src/lib/casper/cspr-trade.js';

/*
 * Guard stores intent amounts in BASE units (motes). CSPR.trade's `amount` parameter takes WHOLE
 * tokens and scales by 10^decimals itself. Passing motes straight through asked the venue for 10^9
 * times the intended trade — a 5 CSPR swap priced as 5,000,000,000 CSPR, which against a ~5M-token
 * pool legitimately quotes ~99.9% price impact. The venue was healthy; our units were wrong.
 */
describe('base units → whole tokens', () => {
  it('converts whole CSPR amounts without a fractional part', () => {
    expect(wholeTokensFromBaseUnits('5000000000')).toBe('5');
    expect(wholeTokensFromBaseUnits('1000000000')).toBe('1');
    expect(wholeTokensFromBaseUnits('10000000000')).toBe('10');
  });

  it('preserves fractional amounts and trims trailing zeros', () => {
    expect(wholeTokensFromBaseUnits('5500000000')).toBe('5.5');
    expect(wholeTokensFromBaseUnits('1')).toBe('0.000000001');
    expect(wholeTokensFromBaseUnits('1500000000')).toBe('1.5');
  });

  it('handles zero and very large amounts exactly (no float precision loss)', () => {
    expect(wholeTokensFromBaseUnits('0')).toBe('0');
    // Beyond Number.MAX_SAFE_INTEGER — must stay exact via BigInt.
    expect(wholeTokensFromBaseUnits('123456789012345678901')).toBe('123456789012.345678901');
  });

  it('respects a non-default decimals value', () => {
    expect(wholeTokensFromBaseUnits('5000000', 6)).toBe('5');
    expect(CSPR_DECIMALS).toBe(9);
  });

  it('round-trips the exact regression: 5 CSPR is "5", never "5000000000"', () => {
    // The literal bug. "5000000000" asked the venue for five billion CSPR.
    expect(wholeTokensFromBaseUnits('5000000000')).not.toBe('5000000000');
    expect(wholeTokensFromBaseUnits('5000000000')).toBe('5');
  });
});

describe('quote/request unit-mismatch guard', () => {
  it('accepts a quote whose echoed amountIn matches the request', () => {
    expect(() =>
      assertQuoteMatchesRequest('5000000000', { amountIn: '5000000000', amountInFormatted: '5' }),
    ).not.toThrow();
  });

  it('rejects a quote priced 1e9 too large — the exact failure mode', () => {
    expect(() =>
      assertQuoteMatchesRequest('5000000000', {
        amountIn: '5000000000000000000',
        amountInFormatted: '5000000000',
      }),
    ).toThrow(/cspr_trade_quote_unit_mismatch/);
  });

  it('names both the requested and priced amounts so the mismatch is diagnosable', () => {
    expect(() =>
      assertQuoteMatchesRequest('5000000000', {
        amountIn: '5000000000000000000',
        amountInFormatted: '5000000000',
      }),
    ).toThrow(/requested 5000000000 base units but the venue priced 5000000000000000000/);
  });

  it('stays silent when the venue does not echo an input amount', () => {
    expect(() => assertQuoteMatchesRequest('5000000000', {})).not.toThrow();
  });
});
