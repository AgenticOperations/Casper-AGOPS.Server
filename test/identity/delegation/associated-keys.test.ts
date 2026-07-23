import { describe, it, expect } from 'vitest';
import {
  buildGrantDeployArgs,
  buildRevokeDeployArgs,
  GRANT_THRESHOLDS,
} from '../../../src/engines/identity/delegation/associated-keys.js';

const MASTER_ACCOUNT = 'account-hash-' + 'a'.repeat(64);
const AGENT_PUBLIC_KEY = '01' + 'b'.repeat(64);

describe('buildGrantDeployArgs (D-2①)', () => {
  it('adds the agent key at weight 1 and sets deploy=1 / key-management=3 thresholds', () => {
    const args = buildGrantDeployArgs({
      masterAccount: MASTER_ACCOUNT,
      agentPublicKey: AGENT_PUBLIC_KEY,
    });

    expect(args.account).toBe(AGENT_PUBLIC_KEY);
    expect(args.weight).toBe(1);
    expect(args.action_threshold_deployment).toBe(GRANT_THRESHOLDS.deployThreshold);
    expect(args.action_threshold_key_management).toBe(GRANT_THRESHOLDS.keyManagementThreshold);
  });

  it('thresholds are fixed at deploy=1, key-management=3 regardless of caller input', () => {
    expect(GRANT_THRESHOLDS).toEqual({ deployThreshold: 1, keyManagementThreshold: 3 });
  });
});

describe('buildRevokeDeployArgs (D-2④)', () => {
  it('zeroes exactly the given key weight and leaves thresholds untouched', () => {
    const args = buildRevokeDeployArgs({
      masterAccount: MASTER_ACCOUNT,
      agentPublicKey: AGENT_PUBLIC_KEY,
    });

    expect(args.account).toBe(AGENT_PUBLIC_KEY);
    expect(args.weight).toBe(0);
    expect((args as unknown as Record<string, unknown>).action_threshold_deployment).toBeUndefined();
    expect((args as unknown as Record<string, unknown>).action_threshold_key_management).toBeUndefined();
  });

  it('grant and revoke never touch a different key than the one passed in', () => {
    const otherKey = '01' + 'c'.repeat(64);
    const grant = buildGrantDeployArgs({ masterAccount: MASTER_ACCOUNT, agentPublicKey: AGENT_PUBLIC_KEY });
    const revoke = buildRevokeDeployArgs({ masterAccount: MASTER_ACCOUNT, agentPublicKey: otherKey });

    expect(grant.account).not.toBe(revoke.account);
  });
});
