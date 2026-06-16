import type { AgentId, AllocationPolicy, OrgId, PolicyId, SpendPolicy } from '../../contracts/index.js';

/**
 * Internal Control-engine records (the Postgres system of record). These are distinct
 * from the cross-engine contracts in `contracts/`: those are edges, these are tables.
 *
 * Invariant (engine-specs-FINAL.md:276-277): an agent holds no private key and no funds.
 * {@link AgentRecord} therefore carries only the *hash* of a bearer token — never a
 * signing key. Signing authority lives exclusively in the KMS (see `lib/kms/signer.ts`).
 */

export type PolicyClass = 'spend' | 'allocation';

export interface OrgRecord {
  id: OrgId;
  name: string;
  adminKeyHash: string;
  /** Per-org monotonic epoch; bumped on every policy version (NFR-03 stale-cache guard). */
  policyEpoch: number;
}

export interface TeamRecord {
  id: string; // `team_…`
  orgId: OrgId;
  parentTeamId: string | null;
  name: string;
}

export interface AgentRecord {
  id: AgentId; // `agt_…`
  orgId: OrgId;
  teamId: string | null;
  /** Human-facing label (0007). Defaults to '' for legacy rows minted before the column existed. */
  name: string;
  /** Hash of the `ag_live_…` bearer token. NOT a signing key — the agent holds none. */
  apiKeyHash: string;
  /** ERC-8004 passport id, issued read-side in M7. */
  passportId: string | null;
  /** 'retired' (0007) is terminal and non-active — the hot path denies any non-active status. */
  status: 'active' | 'suspended' | 'retired';
}

/** Immutable policy version (`policy_id@vN`). An edit inserts a new row; rows never mutate. */
export type PolicyVersionRecord =
  | {
      policyId: PolicyId;
      version: number;
      orgId: OrgId;
      class: 'spend';
      rules: SpendPolicy;
      createdAt: string;
    }
  | {
      policyId: PolicyId;
      version: number;
      orgId: OrgId;
      class: 'allocation';
      rules: AllocationPolicy;
      createdAt: string;
    };
