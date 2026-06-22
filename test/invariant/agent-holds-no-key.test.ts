import { describe, it, expect } from 'vitest';
import { issueAgentApiKey } from '../../src/lib/ids.js';
import type { SignRequest } from '../../src/contracts/index.js';

/**
 * Thesis claim (the core invariant): an agent holds no private key and no funds — it only
 * asks. Financial unbypassability comes from key custody, not network topology
 * (engine-specs-FINAL.md:276-277). Signing authority lives in the KMS; the agent's only
 * credential is a bearer token, and the C-4 sign request it triggers carries no key material.
 */

describe('invariant: an agent holds no private key', () => {
  it('the agent credential is a bearer token, never a signing key', () => {
    const { token, hash } = issueAgentApiKey();
    expect(token.startsWith('ag_live_')).toBe(true);
    expect(token).not.toMatch(/^0x[0-9a-fA-F]{64}$/); // not an EVM private key
    expect(hash).not.toBe(token); // only the hash is persisted; plaintext is shown once
  });

  it('the C-4 sign request carries a role to resolve server-side, never key material', () => {
    const req: SignRequest = {
      paymentId: 'pay_1',
      agentId: 'agt_1',
      rail: { scheme: 'raw-x402', chain: 'arc' },
      quote: {
        resourceId: 'res_1',
        amount: 1_000_000n,
        asset: 'USDC',
        rail: { scheme: 'raw-x402', chain: 'arc' },
        destination: '0x000000000000000000000000000000000000dEaD',
        verifyingContract: '0x0000000000000000000000000000000000000abc',
        x402Scheme: 'exact',
        x402Network: 'arc-testnet',
        originHost: 'api.vendor.test',
        validBefore: 9_999_999_999,
      },
      signerRole: 'agent-float',
    };

    const fields = Object.keys(req);
    expect(fields).not.toContain('privateKey');
    expect(fields).not.toContain('key');
    expect(fields).not.toContain('secret');
    // Authority is a role name, resolved to a KMS key server-side — not a key the agent holds.
    expect(req.signerRole).toBe('agent-float');
  });
});
