import type { AllocationPolicy } from '../../contracts/index.js';
import type { AgentFundingDeps } from '../custody/agent-funding.js';

/**
 * Computes the funding plan for a float provision, encapsulating Review fixes #1 and #2.
 *
 * Fix #1 (no native double-send): the native `depositFor` rail destination (`agentFloatAddress`)
 * ALWAYS stays the operator. The agent's own account is carried SEPARATELY as `agentAccountHash`
 * for the on-chain WCSPR funding — never re-targeting the native transfer to the agent.
 *
 * Fix #2 (destination fence union): when funding runs, the reserve is evaluated against a per-request
 * policy whose `allowedDestinations` adds ONLY the SERVER-derived `agentOwnAccount`. No client/external
 * address is ever added, so the own-agent fence stays intact.
 *
 * Funding runs ONLY when fully configured: a delegated-key agent (`agentOwnAccount` present), a
 * configured WCSPR package hash, a configured operator account, AND injected funding deps. Any gap →
 * today's path verbatim (additive fence), so the unconfigured unit/HTTP harness is unaffected.
 */
export interface ResolveFundingPlanInput {
  allocationPolicy: AllocationPolicy;
  /** SERVER-derived own account (`deriveCasperAccountAddress(delegatedPublicKey)`), or undefined. */
  agentOwnAccount: string | undefined;
  operatorAccountHash: string;
  wcsprPackageHash: string;
  funding: AgentFundingDeps | undefined;
}

export interface AgentFundingPlan {
  /** Native-rail destination — the operator (fix #1). NEVER the agent's own account. Undefined when
   * neither an operator slot nor a policy destination is configured (caller replies no_float_destination). */
  agentFloatAddress: string | undefined;
  /** Per-request policy passed to the reserve; unions the own account when funding runs (fix #2). */
  effectivePolicy: AllocationPolicy;
  /** The agent's own account for on-chain WCSPR funding; present only when funding runs. */
  agentAccountHash?: string;
  /** Funding deps; present only when funding runs. */
  funding?: AgentFundingDeps;
}

export function resolveAgentFundingPlan(input: ResolveFundingPlanInput): AgentFundingPlan {
  const { allocationPolicy, agentOwnAccount, operatorAccountHash, wcsprPackageHash, funding } = input;

  // Native rail destination is always the operator (fix #1). Fall back to policy[0] when the operator
  // slot is unset (pre-migration orgs / unconfigured harness) so today's behavior is preserved.
  const agentFloatAddress =
    operatorAccountHash !== '' ? operatorAccountHash : allocationPolicy.allowedDestinations[0];

  const willFund =
    agentOwnAccount !== undefined &&
    wcsprPackageHash !== '' &&
    operatorAccountHash !== '' &&
    funding !== undefined;

  if (!willFund || agentOwnAccount === undefined || funding === undefined) {
    return { agentFloatAddress, effectivePolicy: allocationPolicy };
  }

  // Fence union (fix #2): add ONLY the server-derived own account so the reserve passes for own-account
  // funding, without weakening the external-redirect fence.
  const effectivePolicy: AllocationPolicy = {
    ...allocationPolicy,
    allowedDestinations: [...allocationPolicy.allowedDestinations, agentOwnAccount],
  };

  return { agentFloatAddress, effectivePolicy, agentAccountHash: agentOwnAccount, funding };
}
