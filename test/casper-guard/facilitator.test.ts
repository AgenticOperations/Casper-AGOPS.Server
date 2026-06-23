import { describe, it, expect } from 'vitest';
import { buildCasperFacilitator } from '../../src/lib/casper/facilitator.js';

describe('buildCasperFacilitator', () => {
  it('returns undefined when no rpc url is configured (honest-blocked)', async () => {
    const fac = await buildCasperFacilitator({ pemPath: '/tmp/x.pem', algorithm: 'secp256k1', rpcUrl: '' });
    expect(fac).toBeUndefined();
  });

  it('returns undefined when no pem path is configured (honest-blocked)', async () => {
    const fac = await buildCasperFacilitator({ pemPath: '', algorithm: 'secp256k1', rpcUrl: 'https://node.testnet.casper.network/rpc' });
    expect(fac).toBeUndefined();
  });
});
