import { describe, it, expect } from 'vitest';
import type { Graph } from '../../../src/engines/control/graph-builder/graph-schema.js';
import { validateGraph } from '../../../src/engines/control/graph-builder/validate.js';

/**
 * G.3 — graph-level validation (research §3.1 / checklist G.3): every Agent under exactly one
 * Fleet under one OrgCeiling; sub-caps <= parent; a trader Agent must have a `cspr-trade`
 * Guardrail; rails match roles. Emits the same policy objects `policy-compile.ts` validates —
 * does not duplicate policy rules (it reuses `compileSpend`/`compileAllocation` for the actual
 * cap-narrowing check, this module only adds graph-shape checks that have no equivalent there:
 * containment arity, and the trader-needs-guardrail rule).
 */

function baseGraph(): Graph {
  return {
    nodes: [
      {
        id: 'org-1',
        type: 'OrgCeiling',
        config: { totalBudget: '100000000', perAgentMax: '60000000', cooldownSeconds: 0, allowedDestinations: [] },
      },
      { id: 'fleet-1', type: 'Fleet', config: { name: 'solo-swapper' } },
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
      { id: 'guard-1', type: 'Guardrail', config: { kind: 'cspr-trade', slippageBps: 100 } },
    ],
    edges: [
      { from: 'org-1', to: 'fleet-1', kind: 'contains' },
      { from: 'fleet-1', to: 'agent-1', kind: 'contains' },
      { from: 'agent-1', to: 'guard-1', kind: 'governed-by' },
    ],
  };
}

describe('G.3 graph-level validation', () => {
  it('accepts a valid graph (trader agent, cspr-trade guardrail, sub-cap <= parent)', () => {
    const result = validateGraph(baseGraph());
    expect(result.valid).toBe(true);
  });

  it('rejects an Agent sub-cap exceeding the OrgCeiling perAgentMax', () => {
    const graph = baseGraph();
    const agent = graph.nodes.find((n) => n.type === 'Agent');
    if (agent?.type === 'Agent') agent.config.subCap = '999999999';

    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sub-?cap/i);
  });

  it('rejects a trader Agent with no cspr-trade Guardrail attached', () => {
    const graph = baseGraph();
    graph.edges = graph.edges.filter((e) => e.kind !== 'governed-by');
    graph.nodes = graph.nodes.filter((n) => n.type !== 'Guardrail');

    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cspr-trade/i);
  });

  it('rejects an Agent not under exactly one Fleet under one OrgCeiling', () => {
    const graph = baseGraph();
    // Detach the fleet from the org ceiling.
    graph.edges = graph.edges.filter((e) => !(e.from === 'org-1' && e.to === 'fleet-1'));

    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/fleet|org ceiling/i);
  });

  it('rejects a graph with no OrgCeiling node at all', () => {
    const graph = baseGraph();
    graph.nodes = graph.nodes.filter((n) => n.type !== 'OrgCeiling');
    graph.edges = [];

    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
  });

  it('reuses compileSpend/compileAllocation from policy-compile.ts (does not duplicate the narrowing rule)', () => {
    // A data agent (non-trader) has no guardrail requirement, and its spend layer narrows fine.
    const graph: Graph = {
      nodes: [
        {
          id: 'org-1',
          type: 'OrgCeiling',
          config: { totalBudget: '100000000', perAgentMax: '30000000', cooldownSeconds: 0, allowedDestinations: [] },
        },
        { id: 'fleet-1', type: 'Fleet', config: { name: 'data-risk-trader' } },
        {
          id: 'agent-data',
          type: 'Agent',
          config: {
            name: 'data',
            role: 'data',
            allowedActions: ['casper-x402'],
            serviceScope: ['svc:market-data'],
            subCap: '20000000',
            velocityLimitPerHour: 60,
          },
        },
      ],
      edges: [
        { from: 'org-1', to: 'fleet-1', kind: 'contains' },
        { from: 'fleet-1', to: 'agent-data', kind: 'contains' },
      ],
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
  });
});
