/**
 * Associated-key argument builders for the delegation lifecycle (D-1, D-2).
 *
 * SCOPE NOTE: Casper's `update_associated_keys` is not a native Transaction type in
 * casper-js-sdk v5 (no `Native*Builder` for it, unlike transfer/delegate/bid). It requires a
 * session Wasm module calling the `add_associated_key` / `set_action_threshold` host functions,
 * submitted via `SessionBuilder.wasm(bytes)`. This repo has no such Wasm bundled and the exact
 * host-function arg names are unverified — sourcing/compiling that Wasm and confirming its args
 * is a spike (same treatment as the CSPR.trade D-7 spike already flagged in BUILD-ORDER.md).
 *
 * This module builds ONLY the verified, pure part: the weight/threshold arguments per D-2①/D-2④.
 * The deploy-assembly step (wiring these args + injected wasmBytes into a SessionBuilder,
 * unsigned) is intentionally NOT implemented here until the Wasm source is confirmed.
 */

export const GRANT_THRESHOLDS = {
  deployThreshold: 1,
  keyManagementThreshold: 3,
} as const;

export interface AssociatedKeyDeployInput {
  masterAccount: string;
  agentPublicKey: string;
}

export interface GrantDeployArgs {
  account: string;
  weight: 1;
  action_threshold_deployment: number;
  action_threshold_key_management: number;
}

export interface RevokeDeployArgs {
  account: string;
  weight: 0;
}

/** D-2①: agent key at weight 1, deploy threshold 1, key-management threshold 3. */
export function buildGrantDeployArgs(input: AssociatedKeyDeployInput): GrantDeployArgs {
  return {
    account: input.agentPublicKey,
    weight: 1,
    action_threshold_deployment: GRANT_THRESHOLDS.deployThreshold,
    action_threshold_key_management: GRANT_THRESHOLDS.keyManagementThreshold,
  };
}

/** D-2④: zero exactly the given key's weight. Thresholds are left untouched. */
export function buildRevokeDeployArgs(input: AssociatedKeyDeployInput): RevokeDeployArgs {
  return {
    account: input.agentPublicKey,
    weight: 0,
  };
}
