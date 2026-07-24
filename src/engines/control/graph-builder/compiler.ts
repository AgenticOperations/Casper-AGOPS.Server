import type { AllocationPolicy, SpendPolicy, SpendRailPermission } from '../../../contracts/index.js';
import type { Graph, GraphNode, NodeType } from './graph-schema.js';

/**
 * G.2 — graph <-> config compiler (BUILD-CHECKLIST-visual-builder.md Milestone G.2).
 *
 * `compileGraphToConfig` turns a validated graph into the SAME shapes the existing Phase-2
 * `policy-compile.ts` / `trading-flow.ts` compilers already produce and the proxy already
 * enforces (see reference shapes in the phase2-sdk-proxy worktree, read-only): an
 * `AllocationPolicy` org ceiling, a `CompiledTradingFlow`-shaped flow (role -> SpendPolicy), and
 * a list of delegated-key GRANT INTENTS (data only — never a signature, never a deploy). This
 * module does not duplicate `compileSpend`/`compileAllocation`; a role's SpendPolicy here is
 * built the same way `trading-flow.ts#compileTradingFlow` builds it (subCap -> spendCap /
 * perTransactionMax, serviceScope, railPermission = allowedActions), so the output is structurally
 * a drop-in for that compiler once Phase 2 merges.
 *
 * `configToGraph` is the exact inverse, so an existing (or freshly compiled) fleet re-hydrates
 * onto the canvas — this is what Milestone I.5 (live status) rehydrates against.
 */

export interface CompiledFlowRole {
  role: string;
  agentName: string;
  allowedActions: readonly SpendRailPermission[];
  serviceScope: string[];
  spend: SpendPolicy;
  guardrails: Array<{ kind: SpendRailPermission; slippageBps?: number; allowedPairs?: string[]; riskLabels?: string[] }>;
}

export interface CompiledFlow {
  name: string;
  version: number;
  roles: CompiledFlowRole[];
}

export interface GrantIntent {
  agentRef: string;
  weight: 1;
  status: 'pending' | 'granted' | 'revoked';
}

export interface CompiledGraphConfig {
  fleetName: string;
  orgCeiling: AllocationPolicy;
  flow: CompiledFlow;
  grantIntents: GrantIntent[];
  serviceRails: Array<{ resourceId: string; destination: string }>;
}

function nodesByType<T extends NodeType>(graph: Graph, type: T): Array<Extract<GraphNode, { type: T }>> {
  return graph.nodes.filter((n): n is Extract<GraphNode, { type: T }> => n.type === type);
}

function childrenOf(graph: Graph, id: string, kind?: string): string[] {
  return graph.edges.filter((e) => e.from === id && (!kind || e.kind === kind)).map((e) => e.to);
}

/** G.2: graph -> AgentOps config. Assumes the graph already passed G.3 validation. */
export function compileGraphToConfig(graph: Graph): CompiledGraphConfig {
  const orgNodes = nodesByType(graph, 'OrgCeiling');
  const fleetNodes = nodesByType(graph, 'Fleet');
  const flowNodes = nodesByType(graph, 'TradingFlow');
  const agentNodes = nodesByType(graph, 'Agent');
  const guardrailNodes = nodesByType(graph, 'Guardrail');
  const grantNodes = nodesByType(graph, 'DelegatedKeyGrant');
  const railNodes = nodesByType(graph, 'ServiceRail');

  const org = orgNodes[0];
  const fleet = fleetNodes[0];
  const flow = flowNodes[0];

  if (!org) throw new Error('compileGraphToConfig: graph has no OrgCeiling node');
  if (!fleet) throw new Error('compileGraphToConfig: graph has no Fleet node');

  const orgCeiling: AllocationPolicy = {
    totalBudget: BigInt(org.config.totalBudget),
    perAgentMax: BigInt(org.config.perAgentMax),
    cooldownSeconds: org.config.cooldownSeconds,
    allowedDestinations: org.config.allowedDestinations,
  };

  const guardrailById = new Map(guardrailNodes.map((g) => [g.id, g]));

  const roles: CompiledFlowRole[] = agentNodes.map((agent) => {
    const subCap = BigInt(agent.config.subCap);
    const attachedGuardrailIds = childrenOf(graph, agent.id, 'governed-by');
    const guardrails = attachedGuardrailIds
      .map((id) => guardrailById.get(id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined)
      .map((g) => {
        const guardrail: {
          kind: SpendRailPermission;
          slippageBps?: number;
          allowedPairs?: string[];
          riskLabels?: string[];
        } = { kind: g.config.kind as SpendRailPermission };
        if (g.config.slippageBps !== undefined) guardrail.slippageBps = g.config.slippageBps;
        if (g.config.allowedPairs !== undefined) guardrail.allowedPairs = g.config.allowedPairs;
        if (g.config.riskLabels !== undefined) guardrail.riskLabels = g.config.riskLabels;
        return guardrail;
      });

    const spend: SpendPolicy = {
      spendCap: subCap,
      perTransactionMax: subCap,
      serviceScope: agent.config.serviceScope,
      railPermission: [...agent.config.allowedActions],
      velocityLimitPerHour: agent.config.velocityLimitPerHour,
    };

    return {
      role: agent.config.role,
      agentName: agent.config.name,
      allowedActions: agent.config.allowedActions,
      serviceScope: agent.config.serviceScope,
      spend,
      guardrails,
    };
  });

  const grantIntents: GrantIntent[] = grantNodes.map((g) => ({
    agentRef: g.config.agentRef,
    weight: g.config.weight,
    status: g.config.status,
  }));

  const serviceRails = railNodes.map((r) => ({
    resourceId: r.config.resourceId,
    destination: r.config.destination,
  }));

  return {
    fleetName: fleet.config.name,
    orgCeiling,
    flow: {
      name: flow?.config.name ?? fleet.config.name,
      version: flow?.config.version ?? 1,
      roles,
    },
    grantIntents,
    serviceRails,
  };
}

/** G.2: AgentOps config -> graph (the inverse), so an existing fleet re-hydrates onto the canvas. */
export function configToGraph(config: CompiledGraphConfig): Graph {
  const nodes: Graph['nodes'] = [];
  const edges: Graph['edges'] = [];

  const orgId = 'org-ceiling';
  const fleetId = 'fleet';
  const flowId = 'trading-flow';

  nodes.push({
    id: orgId,
    type: 'OrgCeiling',
    config: {
      totalBudget: config.orgCeiling.totalBudget.toString(),
      perAgentMax: config.orgCeiling.perAgentMax.toString(),
      cooldownSeconds: config.orgCeiling.cooldownSeconds,
      allowedDestinations: config.orgCeiling.allowedDestinations,
    },
  });
  nodes.push({ id: fleetId, type: 'Fleet', config: { name: config.fleetName } });
  edges.push({ from: orgId, to: fleetId, kind: 'contains' });

  nodes.push({ id: flowId, type: 'TradingFlow', config: { name: config.flow.name, version: config.flow.version } });
  edges.push({ from: fleetId, to: flowId, kind: 'contains' });

  config.flow.roles.forEach((role, i) => {
    const agentId = `agent-${i}-${role.role}`;
    nodes.push({
      id: agentId,
      type: 'Agent',
      config: {
        name: role.agentName,
        role: role.role,
        allowedActions: [...role.allowedActions],
        serviceScope: role.serviceScope,
        subCap: role.spend.spendCap.toString(),
        velocityLimitPerHour: role.spend.velocityLimitPerHour,
      },
    });
    edges.push({ from: flowId, to: agentId, kind: 'attaches-to' });

    role.guardrails.forEach((g, j) => {
      const guardId = `guardrail-${i}-${j}`;
      nodes.push({
        id: guardId,
        type: 'Guardrail',
        config: {
          kind: g.kind,
          slippageBps: g.slippageBps,
          allowedPairs: g.allowedPairs,
          riskLabels: g.riskLabels,
        },
      });
      edges.push({ from: agentId, to: guardId, kind: 'governed-by' });
    });
  });

  config.grantIntents.forEach((intent, i) => {
    const grantId = `grant-${i}`;
    nodes.push({
      id: grantId,
      type: 'DelegatedKeyGrant',
      config: { agentRef: intent.agentRef, weight: intent.weight, status: intent.status },
    });
    const ownerAgent = nodes.find(
      (n): n is Extract<GraphNode, { type: 'Agent' }> => n.type === 'Agent' && n.id === intent.agentRef,
    );
    if (ownerAgent) edges.push({ from: ownerAgent.id, to: grantId, kind: 'attaches-to' });
  });

  config.serviceRails.forEach((rail, i) => {
    nodes.push({
      id: `rail-${i}`,
      type: 'ServiceRail',
      config: { resourceId: rail.resourceId, destination: rail.destination },
    });
  });

  return { nodes, edges };
}
