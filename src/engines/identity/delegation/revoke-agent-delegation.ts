import type pg from 'pg';
import type { Redis } from 'ioredis';
import { suspendAgent } from '../../control/kill-switch.js';
import { revokeDelegatedKey } from './delegated-keys-store.js';
import { revokeAgentInFlight, type RevokeAgentInFlightResult } from '../../casper-guard/policy.js';

export interface RevokeAgentDelegationDeps {
  pool: pg.Pool;
  redis: Redis;
  suspendAgent: typeof suspendAgent;
  revokeDelegatedKey: typeof revokeDelegatedKey;
  revokeAgentInFlight: typeof revokeAgentInFlight;
}

export interface RevokeAgentDelegationResult extends RevokeAgentInFlightResult {
  agentSuspended: boolean;
}

/**
 * F.1 revokeAgent — the full revoke, composing three already-built pieces in the order D-2④
 * requires: (1) the instant Tier-2 kill-switch (no on-chain wait — an agent must be unable to
 * authorize the instant this call starts), (2) revoke the agent's delegated key record (Milestone
 * C), (3) abort any still-RESERVED (not yet signed) in-flight decisions while leaving
 * SIGNED-or-further ones to settle (Milestone A.5). The on-chain revoke DEPLOY itself
 * (buildRevokeDeployArgs, Milestone A.2) is a separate, user/SDK-signed step — this function only
 * covers the proxy-side effects that must happen immediately, independent of that deploy landing.
 */
export async function revokeAgentDelegation(
  deps: RevokeAgentDelegationDeps,
  params: { agentId: string; orgId: string },
): Promise<RevokeAgentDelegationResult> {
  const agentSuspended = await deps.suspendAgent(deps.pool, { agentId: params.agentId, orgId: params.orgId });
  await deps.revokeDelegatedKey(deps.pool, { agentId: params.agentId });
  const inFlight = await deps.revokeAgentInFlight(
    { pool: deps.pool, redis: deps.redis },
    { agentId: params.agentId, orgId: params.orgId },
  );

  return { agentSuspended, ...inFlight };
}
