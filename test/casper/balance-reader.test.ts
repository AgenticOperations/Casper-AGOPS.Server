import { describe, it, expect, vi, afterEach } from 'vitest';
import { queryCasperAccountBalance } from '../../src/lib/casper/balance-reader.js';

describe('queryCasperAccountBalance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the balance from a successful query_balance response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        jsonrpc: '2.0',
        id: 1,
        result: { balance: '123456789000' },
      }),
    }));

    const result = await queryCasperAccountBalance({
      rpcUrl: 'https://node.example.invalid/rpc',
      accountHash: 'a'.repeat(64),
    });
    expect(result).toEqual({ ok: true, motes: 123456789000n });
  });

  it('returns ok:false when the RPC call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await queryCasperAccountBalance({
      rpcUrl: 'https://node.example.invalid/rpc',
      accountHash: 'a'.repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: 'rpc_error' });
  });

  it('returns ok:false when the response has no balance field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'not found' } }),
    }));

    const result = await queryCasperAccountBalance({
      rpcUrl: 'https://node.example.invalid/rpc',
      accountHash: 'a'.repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: 'rpc_error' });
  });
});
