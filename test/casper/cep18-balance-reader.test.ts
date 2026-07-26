import { describe, it, expect, vi } from 'vitest';
import {
  createOnChainReaders,
} from '../../src/lib/casper/cep18-balance-reader.js';

const AGENT = '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a';
const WCSPR_PKG = '3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e';

// Minimal JSON-RPC fetch fake dispatching on the `method` field.
function fakeFetch(handlers: Record<string, (params: unknown) => unknown>) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: unknown };
    const h = handlers[req.method];
    if (!h) throw new Error('unexpected method ' + req.method);
    const out = h(req.params) as { error?: unknown; result?: unknown };
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, ...out }),
    } as unknown as Response;
  });
}

describe('readAccountPurseExists', () => {
  it('returns false when query_balance reports no main purse (account never funded)', async () => {
    const fetchFn = fakeFetch({
      query_balance: () => ({ error: { code: -32026, message: 'purse not found' } }),
    });
    const readers = createOnChainReaders({
      rpcUrl: 'http://node',
      wcsprPackageHash: WCSPR_PKG,
      operatorAccountHash: '00' + '00'.repeat(31) + '01',
      balancesUref: 'uref-abc-007',
      fetchFn: fetchFn,
    });
    expect(await readers.readAccountPurseExists(AGENT)).toBe(false);
  });

  it('returns true when query_balance returns a balance', async () => {
    const fetchFn = fakeFetch({
      query_balance: () => ({ result: { balance: '123' } }),
    });
    const readers = createOnChainReaders({
      rpcUrl: 'http://node',
      wcsprPackageHash: WCSPR_PKG,
      operatorAccountHash: '00' + '00'.repeat(31) + '01',
      balancesUref: 'uref-abc-007',
      fetchFn: fetchFn,
    });
    expect(await readers.readAccountPurseExists(AGENT)).toBe(true);
  });
});

describe('readWcsprBalance', () => {
  it('parses the U256 dictionary value into a bigint', async () => {
    const fetchFn = fakeFetch({
      chain_get_state_root_hash: () => ({ result: { state_root_hash: 'srh' } }),
      state_get_dictionary_item: () => ({
        result: { stored_value: { CLValue: { cl_type: 'U256', parsed: '500000000' } } },
      }),
    });
    const readers = createOnChainReaders({
      rpcUrl: 'http://node',
      wcsprPackageHash: WCSPR_PKG,
      operatorAccountHash: '00' + '00'.repeat(31) + '01',
      balancesUref: 'uref-abc-007',
      fetchFn: fetchFn,
    });
    expect(await readers.readWcsprBalance(AGENT)).toBe(500000000n);
  });

  it('returns 0n when the dictionary item is absent (fresh account, never throws)', async () => {
    const fetchFn = fakeFetch({
      chain_get_state_root_hash: () => ({ result: { state_root_hash: 'srh' } }),
      state_get_dictionary_item: () => ({
        error: { code: -32003, message: 'value was not found in the global state' },
      }),
    });
    const readers = createOnChainReaders({
      rpcUrl: 'http://node',
      wcsprPackageHash: WCSPR_PKG,
      operatorAccountHash: '00' + '00'.repeat(31) + '01',
      balancesUref: 'uref-abc-007',
      fetchFn: fetchFn,
    });
    expect(await readers.readWcsprBalance(AGENT)).toBe(0n);
  });

  it('derives the dictionary item key as base64 of the 33-byte account-hash Key', async () => {
    let capturedKey = '';
    const fetchFn = fakeFetch({
      chain_get_state_root_hash: () => ({ result: { state_root_hash: 'srh' } }),
      state_get_dictionary_item: (params) => {
        capturedKey = (params as { dictionary_identifier: { URef: { dictionary_item_key: string } } })
          .dictionary_identifier.URef.dictionary_item_key;
        return { result: { stored_value: { CLValue: { cl_type: 'U256', parsed: '1' } } } };
      },
    });
    const readers = createOnChainReaders({
      rpcUrl: 'http://node',
      wcsprPackageHash: WCSPR_PKG,
      operatorAccountHash: '00' + '00'.repeat(31) + '01',
      balancesUref: 'uref-abc-007',
      fetchFn: fetchFn,
    });
    await readers.readWcsprBalance(AGENT);
    // base64 of the 33-byte Key (00 tag + 32-byte account hash), confirmed on testnet.
    expect(capturedKey).toBe('ABiFuZLnoLVLNRGFWjmy+s7wnZa1et82QR86S/6E9AAa');
  });
});
