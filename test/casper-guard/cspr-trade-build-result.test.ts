import { describe, it, expect } from 'vitest';
import { resolveUnsignedTransactionJson } from '../../src/lib/casper/cspr-trade.js';

describe('resolveUnsignedTransactionJson (fixes a real bug found live: build_swap on the current CSPR.trade MCP returns the raw Transaction V1 object directly, not wrapped in a deploy_json/deploy field)', () => {
  it('prefers the deploy_json field when present', () => {
    const result = resolveUnsignedTransactionJson({ deploy_json: '{"hash":"a"}' });
    expect(result).toBe('{"hash":"a"}');
  });

  it('falls back to the deploy field when deploy_json is absent', () => {
    const result = resolveUnsignedTransactionJson({ deploy: '{"hash":"b"}' });
    expect(result).toBe('{"hash":"b"}');
  });

  it('treats the whole object as the transaction when it looks like a raw Transaction V1 (has hash + payload, confirmed live shape)', () => {
    const raw = { hash: 'abc', payload: { initiator_addr: {} }, approvals: [] };
    const result = resolveUnsignedTransactionJson(raw);
    expect(JSON.parse(result!)).toEqual(raw);
  });

  it('treats the whole object as the transaction when it looks like a legacy Deploy (has header + body)', () => {
    const raw = { hash: 'abc', header: {}, body: {}, approvals: [] };
    const result = resolveUnsignedTransactionJson(raw);
    expect(JSON.parse(result!)).toEqual(raw);
  });

  it('returns undefined when the object matches none of the known shapes', () => {
    expect(resolveUnsignedTransactionJson({ unrelated: true })).toBeUndefined();
  });
});
