import { describe, it, expect } from 'vitest';
import type { Graph } from '../../../src/engines/control/graph-builder/graph-schema.js';
import {
  compileGraphToConfig,
  configToGraph,
} from '../../../src/engines/control/graph-builder/compiler.js';

/**
 * G.2 — compileGraphToConfig(graph) -> AgentOps config (agents, policy layers, flow attachment,
 * grant intents); the inverse configToGraph(config) so an existing fleet re-hydrates onto the
 * canvas. Round-trip: configToGraph(compileGraphToConfig(g)) is equivalent to g for a valid graph.
 */

function soloSwapperGraph(): Graph {
  return {
    nodes: [
      {
        id: 'org-1',
        type: 'OrgCeiling',
        config: {
          totalBudget: '100000000',
          perAgentMax: '60000000',
          cooldownSeconds: 0,
          allowedDestinations: [],
        },
      },
      { id: 'fleet-1', type: 'Fleet', config: { name: 'solo-swapper' } },
      { id: 'flow-1', type: 'TradingFlow', config: { name: 'solo-swapper', version: 1 } },
      {
        id: 'agent-1',
        type: 'Agent',
        config: {
          name: 'trader',
          role: 'trader',
          allowedActions: ['cspr-trade'],
          serviceScope: ['cspr.trade:swap'],
          subCap: '60000000',
          velocityLimitPerHour: 10,
        },
      },
      {
        id: 'guard-1',
        type: 'Guardrail',
        config: { kind: 'cspr-trade', slippageBps: 100, allowedPairs: ['CSPR/wETH'] },
      },
    ],
    edges: [
      { from: 'org-1', to: 'fleet-1', kind: 'contains' },
      { from: 'fleet-1', to: 'flow-1', kind: 'contains' },
      { from: 'flow-1', to: 'agent-1', kind: 'attaches-to' },
      { from: 'agent-1', to: 'guard-1', kind: 'governed-by' },
    ],
  };
}

describe('G.2 compileGraphToConfig / configToGraph round-trip', () => {
  it('compiles a valid graph into AgentOps config (orgCeiling, flow, per-agent spend policy)', () => {
    const graph = soloSwapperGraph();
    const config = compileGraphToConfig(graph);

    expect(config.orgCeiling.totalBudget).toBe(100_000_000n);
    expect(config.orgCeiling.perAgentMax).toBe(60_000_000n);
    expect(config.flow.name).toBe('solo-swapper');
    expect(config.flow.roles).toHaveLength(1);
    const role = config.flow.roles[0];
    if (!role) throw new Error('expected a role');
    expect(role.role).toBe('trader');
    expect(role.spend.spendCap).toBe(60_000_000n);
    expect(role.spend.railPermission).toEqual(['cspr-trade']);
    expect(config.grantIntents).toHaveLength(0); // no DelegatedKeyGrant node in this graph
  });

  it('round-trips: configToGraph(compileGraphToConfig(g)) is equivalent to g', () => {
    const graph = soloSwapperGraph();
    const config = compileGraphToConfig(graph);
    const rehydrated = configToGraph(config);

    const byType = (g: Graph, t: string) => g.nodes.filter((n) => n.type === t);

    expect(byType(rehydrated, 'OrgCeiling')).toHaveLength(1);
    expect(byType(rehydrated, 'Fleet')).toHaveLength(1);
    expect(byType(rehydrated, 'TradingFlow')).toHaveLength(1);
    expect(byType(rehydrated, 'Agent')).toHaveLength(1);
    expect(byType(rehydrated, 'Guardrail')).toHaveLength(1);

    const rOrg = byType(rehydrated, 'OrgCeiling')[0];
    if (rOrg && rOrg.type === 'OrgCeiling') {
      expect(rOrg.config.totalBudget).toBe('100000000');
      expect(rOrg.config.perAgentMax).toBe('60000000');
    }

    const rAgent = byType(rehydrated, 'Agent')[0];
    if (rAgent && rAgent.type === 'Agent') {
      expect(rAgent.config.role).toBe('trader');
      expect(rAgent.config.subCap).toBe('60000000');
      expect(rAgent.config.allowedActions).toEqual(['cspr-trade']);
    }

    // containment/attachment shape preserved: org->fleet->flow->agent->guardrail
    const kinds = rehydrated.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual(['attaches-to', 'contains', 'contains', 'governed-by'].sort());
  });

  it('emits a grant intent for each DelegatedKeyGrant node, without signing or deploying', () => {
    const graph = soloSwapperGraph();
    graph.nodes.push({
      id: 'grant-1',
      type: 'DelegatedKeyGrant',
      config: { agentRef: 'agent-1', weight: 1, status: 'pending' },
    });
    graph.edges.push({ from: 'agent-1', to: 'grant-1', kind: 'attaches-to' });

    const config = compileGraphToConfig(graph);
    expect(config.grantIntents).toHaveLength(1);
    expect(config.grantIntents[0]).toEqual({ agentRef: 'agent-1', weight: 1, status: 'pending' });
  });
});
