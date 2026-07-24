/**
 * Associated-key argument builders for the delegation lifecycle (D-1, D-2).
 *
 * Matches the real, verified session contracts in `contracts/delegation/` (grant-delegated-key,
 * revoke-delegated-key) — see that directory's README for the full verification log: both
 * contracts were built and tested end-to-end against a real Casper testnet account (grant, agent
 * transacts alone, revoke, revoked key rejected outright by the node).
 *
 * The grant contract deliberately does NOT match Casper's own two-party-multi-sig reference
 * (a balanced 2-of-2 scheme). D-2① wants asymmetric delegation: the agent's key can transact
 * ALONE (deploy threshold stays low) but can never alone perform key-management. Naively raising
 * only the key-management threshold — without also raising the master's own weight — would brick
 * the account (a default account's own key starts at weight 1; agent(1) + master(1) can never
 * reach a threshold of 3). So the grant contract ALSO bumps the master's own weight
 * (`master_weight`) in the same deploy.
 */

import { PublicKey } from 'casper-js-sdk';

/**
 * Derive the BARE hex account hash (no `account-hash-` prefix) from a Casper PUBLIC key hex.
 * Only public-key material touches this — no private key, no signing. GLOBAL RULE #1.
 */
export function accountHashFromPublicKeyHex(publicKeyHex: string): string {
  return PublicKey.fromHex(publicKeyHex).accountHash().toHex().replace(/^account-hash-/, '');
}

export const GRANT_THRESHOLDS = {
  /** The master's own new weight — high enough to alone satisfy keyManagementThreshold below,
   * so the account is never bricked even if the agent's weight-1 key were somehow unavailable. */
  masterWeight: 3,
  deployThreshold: 1,
  keyManagementThreshold: 3,
} as const;

export interface AssociatedKeyDeployInput {
  masterAccountHash: string;
  agentAccountHash: string;
}

/** Matches grant-delegated-key.wasm's session args exactly (contracts/delegation/). */
export interface GrantDeployArgs {
  agent_account_hash: string;
  master_weight: number;
  key_management_threshold: number;
  deployment_threshold: number;
}

/** Matches revoke-delegated-key.wasm's session args exactly — it calls remove_associated_key,
 * so no weight/threshold fields are needed. */
export interface RevokeDeployArgs {
  agent_account_hash: string;
}

/** D-2①: agent key at weight 1 (set by the contract itself), master bumped to weight 3, deploy
 * threshold 1, key-management threshold 3. */
export function buildGrantDeployArgs(input: AssociatedKeyDeployInput): GrantDeployArgs {
  return {
    agent_account_hash: input.agentAccountHash,
    master_weight: GRANT_THRESHOLDS.masterWeight,
    key_management_threshold: GRANT_THRESHOLDS.keyManagementThreshold,
    deployment_threshold: GRANT_THRESHOLDS.deployThreshold,
  };
}

/** D-2④: remove the given key entirely (not a weight-0 update — see revoke-delegated-key's own
 * doc comment for why removal is the unambiguous choice). Thresholds are left untouched. */
export function buildRevokeDeployArgs(input: AssociatedKeyDeployInput): RevokeDeployArgs {
  return {
    agent_account_hash: input.agentAccountHash,
  };
}

export interface UnsignedGrantDeploy {
  kind: 'update_associated_keys_grant';
  masterAccountHash: string;
  agentAccountHash: string;
  args: GrantDeployArgs;
}

/**
 * D-2②(a): the unsigned deploy args for the BROWSER to sign via CSPR.click. Server never signs —
 * this returns plain data, no key material touched.
 */
export function buildGrantDeployForBrowserSigning(input: AssociatedKeyDeployInput): UnsignedGrantDeploy {
  return {
    kind: 'update_associated_keys_grant',
    masterAccountHash: input.masterAccountHash,
    agentAccountHash: input.agentAccountHash,
    args: buildGrantDeployArgs(input),
  };
}

/**
 * D-2②(b): the SDK helper for headless signing. Deliberately identical to the browser path —
 * proves both entry points produce the same unsigned deploy shape and neither signs server-side.
 */
export function buildGrantDeployForHeadlessSigning(input: AssociatedKeyDeployInput): UnsignedGrantDeploy {
  return buildGrantDeployForBrowserSigning(input);
}
