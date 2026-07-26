import { describe, it, expect } from 'vitest';
import {
  GraphSchema,
  NodeSchemaByType,
  type Graph,
  type GraphNode,
} from '../../../src/engines/control/graph-builder/graph-schema.js';

/**
 * G.1: canonical graph model `{ nodes: [{id, type, config}], edges: [{from, to, kind}] }`.
 * Node types (research §2.1 / checklist G.1): OrgCeiling, Fleet, Agent, Guardrail, TradingFlow,
 * DelegatedKeyGrant, ServiceRail. A Zod schema exists per node type; the graph type compiles.
 */

describe('G.1 graph schema', () => {
  const nodeTypes = [
    'OrgCeiling',
    'Fleet',
    'Agent',
    'Guardrail',
    'TradingFlow',
    'DelegatedKeyGrant',
    'ServiceRail',
  ] as const;

  it('has a Zod schema for every required node type', () => {
    for (const t of nodeTypes) {
      expect(NodeSchemaByType[t]).toBeDefined();
    }
  });

  it('parses a minimal valid graph (OrgCeiling -> Fleet -> Agent -> Guardrail)', () => {
    const graph: Graph = {
      nodes: [
        {
          id: 'org-1',
          type: 'OrgCeiling',
          config: { totalBudget: '100000000', perAgentMax: '50000000', cooldownSeconds: 0, allowedDestinations: [] },
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
            subCap: '10000000',
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
        { from: 'fleet-1', to: 'agent-1', kind: 'contains' },
        { from: 'agent-1', to: 'guard-1', kind: 'governed-by' },
      ],
    };

    const parsed = GraphSchema.parse(graph);
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.edges).toHaveLength(3);
  });

  it('rejects a node with an unknown type', () => {
    const bad = {
      nodes: [{ id: 'x', type: 'NotAType', config: {} }],
      edges: [],
    };
    expect(() => GraphSchema.parse(bad)).toThrow();
  });

  it('rejects an edge kind that implies execution order (never "then run")', () => {
    const bad: unknown = {
      nodes: [
        { id: 'a', type: 'Fleet', config: { name: 'f' } },
        { id: 'b', type: 'Fleet', config: { name: 'g' } },
      ],
      edges: [{ from: 'a', to: 'b', kind: 'then-run' }],
    };
    expect(() => GraphSchema.parse(bad)).toThrow();
  });

  it('type-level: GraphNode union covers all node types', () => {
    const n: GraphNode = { id: 'a', type: 'ServiceRail', config: { resourceId: 'svc:x', destination: '0x1' } };
    expect(n.type).toBe('ServiceRail');
  });
});
