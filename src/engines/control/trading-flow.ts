import type { AllocationPolicy, SpendPolicy, SpendRailPermission } from '../../contracts/index.js';

/**
 * Trading flow object (D-5①②④, Milestone D). A flow is a named, versioned set of agent roles —
 * each role compiles to the SAME SpendPolicy/AllocationPolicy shapes the existing policy validator
 * and casper-guard authorize path already accept (control/policy-compile.ts, casper-guard/policy.ts).
 * No new engine, no new enforcement primitive — this is a compiler over existing objects.
 */
export interface TradingFlowRoleDefinition {
  role: string;
  allowedActions: readonly SpendRailPermission[];
  serviceScope: string[];
  subCap: bigint;
  velocityLimitPerHour: number;
}

export interface TradingFlowDefinition {
  name: string;
  version: number;
  orgCeiling: AllocationPolicy;
  roles: TradingFlowRoleDefinition[];
}

export interface CompiledTradingFlowRole {
  role: string;
  allowedActions: readonly SpendRailPermission[];
  spend: SpendPolicy;
  allocation: AllocationPolicy;
}

export interface CompiledTradingFlow {
  name: string;
  version: number;
  roles: CompiledTradingFlowRole[];
}

/**
 * D.1: compile each role into a SpendPolicy the existing validator already accepts. D.4: budget
 * is the existing org ceiling (AllocationPolicy) + per-role subCap — NO new budget primitive. A
 * role's subCap is rejected here if it could exceed the org's perAgentMax, since the fleet must
 * never collectively (or individually) exceed what the existing allocation enforcement allows.
 */
export function compileTradingFlow(flow: TradingFlowDefinition): CompiledTradingFlow {
  const roles = flow.roles.map((role): CompiledTradingFlowRole => {
    if (role.subCap > flow.orgCeiling.perAgentMax) {
      throw new Error(
        `Role "${role.role}" subCap (${role.subCap}) exceeds org perAgentMax (${flow.orgCeiling.perAgentMax})`,
      );
    }

    return {
      role: role.role,
      allowedActions: role.allowedActions,
      spend: {
        spendCap: role.subCap,
        perTransactionMax: role.subCap,
        serviceScope: role.serviceScope,
        railPermission: [...role.allowedActions],
        velocityLimitPerHour: role.velocityLimitPerHour,
      },
      allocation: flow.orgCeiling,
    };
  });

  return { name: flow.name, version: flow.version, roles };
}

/** D.3: fleet template — role shapes without org-specific numbers, filled in at instantiation. */
export interface FleetTemplate {
  name: string;
  roles: Array<Omit<TradingFlowRoleDefinition, 'subCap' | 'velocityLimitPerHour'> & {
    velocityLimitPerHour: number;
  }>;
}

export const FLEET_TEMPLATES: FleetTemplate[] = [
  {
    name: 'data-risk-trader',
    roles: [
      { role: 'data', allowedActions: ['casper-x402'], serviceScope: ['svc:market-data'], velocityLimitPerHour: 60 },
      { role: 'risk', allowedActions: ['casper-x402'], serviceScope: ['svc:risk-oracle'], velocityLimitPerHour: 30 },
      { role: 'trader', allowedActions: ['cspr-trade'], serviceScope: ['cspr.trade:swap'], velocityLimitPerHour: 10 },
    ],
  },
  {
    name: 'solo-swapper',
    roles: [
      { role: 'trader', allowedActions: ['cspr-trade'], serviceScope: ['cspr.trade:swap'], velocityLimitPerHour: 10 },
    ],
  },
];

/**
 * D.3: instantiate a template under an org's ceiling — each role's subCap is the org perAgentMax
 * divided evenly across the template's role count (a simple, non-negotiated default split; the
 * custom builder path lets an operator set per-role subCap explicitly via compileTradingFlow).
 */
export function instantiateFleetTemplate(
  template: FleetTemplate,
  input: { orgCeiling: AllocationPolicy },
): CompiledTradingFlow {
  const perRoleSubCap = input.orgCeiling.perAgentMax / BigInt(template.roles.length);

  const flow: TradingFlowDefinition = {
    name: template.name,
    version: 1,
    orgCeiling: input.orgCeiling,
    roles: template.roles.map((role) => ({
      ...role,
      subCap: perRoleSubCap,
    })),
  };

  return compileTradingFlow(flow);
}
