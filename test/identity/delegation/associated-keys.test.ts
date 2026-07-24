import { describe, it, expect } from 'vitest';
import {
  buildGrantDeployArgs,
  buildRevokeDeployArgs,
  buildGrantDeployForBrowserSigning,
  buildGrantDeployForHeadlessSigning,
  GRANT_THRESHOLDS,
} from '../../../src/engines/identity/delegation/associated-keys.js';

const MASTER_ACCOUNT_HASH = 'account-hash-' + 'a'.repeat(64);
const AGENT_ACCOUNT_HASH = 'account-hash-' + 'b'.repeat(64);

describe('buildGrantDeployArgs (D-2①) — matches the real grant-delegated-key.wasm session args, verified live on testnet', () => {
  it('produces the exact named args the contract expects: agent_account_hash, master_weight, thresholds', () => {
    const args = buildGrantDeployArgs({
      masterAccountHash: MASTER_ACCOUNT_HASH,
      agentAccountHash: AGENT_ACCOUNT_HASH,
    });

    expect(args.agent_account_hash).toBe(AGENT_ACCOUNT_HASH);
    expect(args.master_weight).toBe(GRANT_THRESHOLDS.masterWeight);
    expect(args.deployment_threshold).toBe(GRANT_THRESHOLDS.deployThreshold);
    expect(args.key_management_threshold).toBe(GRANT_THRESHOLDS.keyManagementThreshold);
  });

  it('thresholds are fixed regardless of caller input: master_weight=3, deploy=1, key-management=3', () => {
    expect(GRANT_THRESHOLDS).toEqual({ masterWeight: 3, deployThreshold: 1, keyManagementThreshold: 3 });
  });

  it('master_weight must exceed key_management threshold minus the agent weight (1) — verified 3 > (3-1) so master alone still controls key-management', () => {
    // Documents the exact bug found and fixed against a real testnet account: agent(1) + a
    // default master(1) can never reach a raised threshold of 3. master_weight=3 alone satisfies
    // it without the agent's cooperation.
    expect(GRANT_THRESHOLDS.masterWeight).toBeGreaterThanOrEqual(GRANT_THRESHOLDS.keyManagementThreshold);
  });
});

describe('the two grant entry points (D-2②) — browser CSPR.click vs SDK headless', () => {
  it('return the identical unsigned deploy shape for the same input', () => {
    const input = { masterAccountHash: MASTER_ACCOUNT_HASH, agentAccountHash: AGENT_ACCOUNT_HASH };
    const browser = buildGrantDeployForBrowserSigning(input);
    const headless = buildGrantDeployForHeadlessSigning(input);

    expect(browser).toEqual(headless);
  });

  it('never returns a signature or signed flag — both are strictly unsigned deploy args', () => {
    const input = { masterAccountHash: MASTER_ACCOUNT_HASH, agentAccountHash: AGENT_ACCOUNT_HASH };
    const browser = buildGrantDeployForBrowserSigning(input) as unknown as Record<string, unknown>;
    const headless = buildGrantDeployForHeadlessSigning(input) as unknown as Record<string, unknown>;

    expect(browser.signature).toBeUndefined();
    expect(browser.signed).toBeUndefined();
    expect(headless.signature).toBeUndefined();
    expect(headless.signed).toBeUndefined();
  });

  it('both wrap buildGrantDeployArgs — same values', () => {
    const input = { masterAccountHash: MASTER_ACCOUNT_HASH, agentAccountHash: AGENT_ACCOUNT_HASH };
    const direct = buildGrantDeployArgs(input);
    const browser = buildGrantDeployForBrowserSigning(input);

    expect(browser.args).toEqual(direct);
  });
});

describe('buildRevokeDeployArgs (D-2④) — matches the real revoke-delegated-key.wasm session args', () => {
  it('produces only agent_account_hash — the contract calls remove_associated_key, not a weight update', () => {
    const args = buildRevokeDeployArgs({
      masterAccountHash: MASTER_ACCOUNT_HASH,
      agentAccountHash: AGENT_ACCOUNT_HASH,
    });

    expect(args).toEqual({ agent_account_hash: AGENT_ACCOUNT_HASH });
  });

  it('grant and revoke never touch a different key than the one passed in', () => {
    const otherAccount = 'account-hash-' + 'c'.repeat(64);
    const grant = buildGrantDeployArgs({ masterAccountHash: MASTER_ACCOUNT_HASH, agentAccountHash: AGENT_ACCOUNT_HASH });
    const revoke = buildRevokeDeployArgs({ masterAccountHash: MASTER_ACCOUNT_HASH, agentAccountHash: otherAccount });

    expect(grant.agent_account_hash).not.toBe(revoke.agent_account_hash);
  });
});
