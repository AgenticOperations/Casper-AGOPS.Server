import { describe, it, expect } from 'vitest';
import {
  hashApiKey,
  issueAdminKey,
  issueAgentApiKey,
  newAgentId,
  newOrgId,
  newPolicyId,
  newTeamId,
  verifyApiKey,
} from '../../src/lib/ids.js';

describe('Control id minting + api-key hashing', () => {
  it('mints prefixed, unique ids', () => {
    expect(newOrgId()).toMatch(/^org_[0-9a-f]{32}$/);
    expect(newAgentId()).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(newTeamId()).toMatch(/^team_[0-9a-f]{32}$/);
    expect(newPolicyId()).toMatch(/^policy_[0-9a-f]{32}$/);
    expect(newOrgId()).not.toBe(newOrgId());
  });

  it('issues an agent key as ag_live_ and persists only its hash', () => {
    const { token, hash } = issueAgentApiKey();
    expect(token.startsWith('ag_live_')).toBe(true);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApiKey(token, hash)).toBe(true);
  });

  it('issues an admin key as sk_live_', () => {
    const { token } = issueAdminKey();
    expect(token.startsWith('sk_live_')).toBe(true);
  });

  it('verifies constant-time: wrong token fails, hashing is deterministic', () => {
    const { token, hash } = issueAgentApiKey();
    expect(verifyApiKey('ag_live_wrong', hash)).toBe(false);
    expect(hashApiKey(token)).toBe(hashApiKey(token));
  });
});
