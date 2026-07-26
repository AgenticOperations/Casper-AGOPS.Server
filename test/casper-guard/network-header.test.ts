import { describe, it, expect } from 'vitest';
import { resolveRequestNetwork } from '../../src/engines/casper-guard/network-header.js';

describe('resolveRequestNetwork', () => {
  it('defaults to testnet when header absent', () => {
    expect(resolveRequestNetwork(undefined)).toEqual({ ok: true, network: 'casper:casper-test' });
  });
  it('accepts casper:casper-test', () => {
    expect(resolveRequestNetwork('casper:casper-test')).toEqual({ ok: true, network: 'casper:casper-test' });
  });
  it('accepts casper:casper', () => {
    expect(resolveRequestNetwork('casper:casper')).toEqual({ ok: true, network: 'casper:casper' });
  });
  it('rejects an unknown value', () => {
    expect(resolveRequestNetwork('casper:bogus')).toEqual({ ok: false });
  });
  it('rejects an array header', () => {
    expect(resolveRequestNetwork(['casper:casper'])).toEqual({ ok: false });
  });
});
