import { describe, it, expect } from 'vitest';
import { parseMcpToolText } from '../../src/lib/casper/cspr-trade.js';

describe('parseMcpToolText (fixes a real bug found live: build_swap returns a human-readable summary + embedded JSON, not pure JSON)', () => {
  it('parses pure JSON text directly', () => {
    expect(parseMcpToolText('{"deploy_json":"abc"}')).toEqual({ deploy_json: 'abc' });
  });

  it('extracts and parses the embedded JSON block when the text has a human-readable summary first', () => {
    // Matches the real response shape observed live from build_swap on testnet.
    const text =
      'Swap 1 CSPR for ~0.935537133 sCSPR\n' +
      'Route: CSPR → sCSPR\n' +
      'Price impact: 0.3000%\n' +
      'Max slippage: 3.00%\n' +
      'Deadline: 20 minutes\n' +
      'Estimated gas: 30 CSPR\n\n' +
      'Swap transaction JSON:\n' +
      '{"deploy_json":"abc123"}';

    expect(parseMcpToolText(text)).toEqual({ deploy_json: 'abc123' });
  });

  it('throws a clear error when there is no JSON anywhere in the text', () => {
    expect(() => parseMcpToolText('completely plain text, no braces at all')).toThrow(/non-JSON/);
  });

  it('throws when text has a brace but it is not valid JSON', () => {
    expect(() => parseMcpToolText('some text { not valid json')).toThrow(/non-JSON/);
  });

  it('extracts the JSON block even when there is trailing non-JSON text after it (the real build_swap shape: a large deploy JSON followed by "Pass this JSON to sign_deploy...")', () => {
    const text =
      'Swap 1 CSPR for ~0.935 sCSPR\n' +
      'Swap transaction JSON:\n' +
      '{"hash":"abc","nested":{"a":1,"b":"contains } and { braces in a string"}}\n' +
      'Pass this JSON to sign_deploy, then submit the signed JSON with submit_transaction.';

    expect(parseMcpToolText(text)).toEqual({ hash: 'abc', nested: { a: 1, b: 'contains } and { braces in a string' } });
  });
});
