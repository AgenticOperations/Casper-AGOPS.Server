import { describe, it, expect } from 'vitest';
import { buildHttpCasperFacilitator } from '../../src/lib/casper/facilitator.js';

describe('buildHttpCasperFacilitator', () => {
  it('returns undefined when facilitatorUrl is empty (honest-blocked)', () => {
    const fac = buildHttpCasperFacilitator({ facilitatorUrl: '', accessToken: '' });
    expect(fac).toBeUndefined();
  });

  it('returns a facilitator with verify and settle when url is set', () => {
    const fac = buildHttpCasperFacilitator({ facilitatorUrl: 'https://x402-facilitator.cspr.cloud', accessToken: 'test-token' });
    expect(fac).toBeDefined();
    expect(typeof fac!.verify).toBe('function');
    expect(typeof fac!.settle).toBe('function');
  });
});
