import { describe, it, expect, vi } from 'vitest';
import {
  promptToGraph,
  DEFAULT_GRAPH_MODEL,
  type GraphModelClient,
} from '../../../src/engines/control/graph-builder/prompt-to-graph.js';
import type { Graph } from '../../../src/engines/control/graph-builder/graph-schema.js';

/**
 * H.1/H.2/H.3 — server-side promptToGraph(prompt): calls Gemini with JSON-constrained
 * structured output so it emits ONLY a graph JSON matching Milestone G's schema; runs the
 * generate -> validate -> self-correct loop (one correction pass on validation failure);
 * few-shots on the FLEET_TEMPLATES shapes.
 *
 * The Gemini client is injected (DI) so these tests never hit the network — this also
 * proves the endpoint's call surface takes a client dependency rather than constructing its
 * own module-level singleton with a hardcoded key.
 */

function dataRiskTraderGraph(): Graph {
  return {
    nodes: [
      {
        id: 'org-1',
        type: 'OrgCeiling',
        config: { totalBudget: '100000000', perAgentMax: '60000000', cooldownSeconds: 0, allowedDestinations: [] },
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
      {
        id: 'agent-risk',
        type: 'Agent',
        config: {
          name: 'risk',
          role: 'risk',
          allowedActions: ['casper-x402'],
          serviceScope: ['svc:risk-oracle'],
          subCap: '20000000',
          velocityLimitPerHour: 30,
        },
      },
      {
        id: 'agent-trader',
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
        id: 'guard-trader',
        type: 'Guardrail',
        config: { kind: 'cspr-trade', slippageBps: 100, allowedPairs: ['CSPR/wETH'] },
      },
    ],
    edges: [
      { from: 'org-1', to: 'fleet-1', kind: 'contains' },
      { from: 'fleet-1', to: 'agent-data', kind: 'contains' },
      { from: 'fleet-1', to: 'agent-risk', kind: 'contains' },
      { from: 'fleet-1', to: 'agent-trader', kind: 'contains' },
      { from: 'agent-trader', to: 'guard-trader', kind: 'governed-by' },
    ],
  };
}

/** Returns each graph in turn as a Gemini JSON response (last one repeats). */
function mockGeminiReturning(...graphs: Graph[]) {
  let call = 0;
  const generateContent = vi.fn().mockImplementation(() => {
    const graph = graphs[Math.min(call, graphs.length - 1)];
    call += 1;
    return Promise.resolve({ text: JSON.stringify(graph) });
  });
  return { models: { generateContent } } satisfies GraphModelClient;
}

const generateContentOf = (client: GraphModelClient) =>
  client.models.generateContent as unknown as ReturnType<typeof vi.fn>;

describe('H.1 promptToGraph — schema-constrained structured output', () => {
  it('returns a valid graph for a data+risk+trader prompt (H.1 acceptance example)', async () => {
    const client = mockGeminiReturning(dataRiskTraderGraph());
    const result = await promptToGraph(client, {
      prompt:
        'data + risk agent feeding a trader, 100 CSPR cap, trader 60, CSPR/wETH, 1% slippage',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = result.graph;
    expect(graph.nodes.filter((n) => n.type === 'OrgCeiling')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.type === 'Fleet')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.type === 'Agent')).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.type === 'Guardrail').length).toBeGreaterThanOrEqual(1);

    const org = graph.nodes.find((n) => n.type === 'OrgCeiling');
    if (org?.type === 'OrgCeiling') expect(org.config.totalBudget).toBe('100000000');
  });

  it('constrains the model to JSON output only — never asks for free-form code', async () => {
    const client = mockGeminiReturning(dataRiskTraderGraph());
    await promptToGraph(client, { prompt: 'solo swapper, 10 CSPR cap' });

    const callArgs = generateContentOf(client).mock.calls[0]![0];
    expect(callArgs.config.responseMimeType).toBe('application/json');
    // Config synthesis against a fixed schema — deterministic, not creative.
    expect(callArgs.config.temperature).toBe(0);
    expect(callArgs.config.systemInstruction).toMatch(/ONLY a single JSON object/);
  });

  it('defaults to a flash-tier model and honours an explicit model override', async () => {
    const client = mockGeminiReturning(dataRiskTraderGraph());

    await promptToGraph(client, { prompt: 'solo swapper' });
    expect(generateContentOf(client).mock.calls[0]![0].model).toBe(DEFAULT_GRAPH_MODEL);

    await promptToGraph(client, { prompt: 'solo swapper', model: 'gemini-2.5-pro' });
    expect(generateContentOf(client).mock.calls[1]![0].model).toBe('gemini-2.5-pro');
  });

  it('treats unparseable or empty model output as a failed attempt rather than throwing', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: undefined });
    const client = { models: { generateContent } } satisfies GraphModelClient;

    const result = await promptToGraph(client, { prompt: 'anything' });

    expect(result.ok).toBe(false);
    expect(generateContent).toHaveBeenCalledTimes(2); // still runs the H.2 correction pass
  });

  it('tolerates a markdown-fenced JSON response', async () => {
    const graph = dataRiskTraderGraph();
    const generateContent = vi
      .fn()
      .mockResolvedValue({ text: '```json\n' + JSON.stringify(graph) + '\n```' });
    const client = { models: { generateContent } } satisfies GraphModelClient;

    const result = await promptToGraph(client, { prompt: 'data+risk+trader' });

    expect(result.ok).toBe(true);
  });
});

describe('H.2 generate -> validate -> self-correct loop', () => {
  it('corrects an invalid first attempt on the second pass', async () => {
    const badGraph = dataRiskTraderGraph();
    // Break it: remove the trader's guardrail so it fails the trader-needs-guardrail rule.
    badGraph.edges = badGraph.edges.filter((e) => e.kind !== 'governed-by');
    badGraph.nodes = badGraph.nodes.filter((n) => n.type !== 'Guardrail');

    const goodGraph = dataRiskTraderGraph();
    const client = mockGeminiReturning(badGraph, goodGraph);

    const result = await promptToGraph(client, { prompt: 'data+risk+trader fleet' });

    expect(generateContentOf(client)).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const hasGuardrail = result.graph.nodes.some((n) => n.type === 'Guardrail');
      expect(hasGuardrail).toBe(true);
    }
  });

  it('returns a clear "need more info" message rather than an invalid graph when both passes fail', async () => {
    const badGraph = dataRiskTraderGraph();
    badGraph.edges = badGraph.edges.filter((e) => e.kind !== 'governed-by');
    badGraph.nodes = badGraph.nodes.filter((n) => n.type !== 'Guardrail');

    const client = mockGeminiReturning(badGraph, badGraph);
    const result = await promptToGraph(client, { prompt: 'underspecified trading fleet' });

    expect(generateContentOf(client)).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/need more info|validation failed|could not produce/i);
    }
  });
});

describe('H.3 few-shot on FLEET_TEMPLATES', () => {
  it('includes the data-risk-trader and solo-swapper template shapes in the system prompt', async () => {
    const client = mockGeminiReturning(dataRiskTraderGraph());
    await promptToGraph(client, { prompt: 'solo swapper fleet' });

    const callArgs = generateContentOf(client).mock.calls[0]![0];
    const system = String(callArgs.config.systemInstruction ?? '');
    expect(system).toMatch(/data-risk-trader/);
    expect(system).toMatch(/solo-swapper/);
  });
});
