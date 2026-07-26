import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GraphSchema } from '../../../src/engines/control/graph-builder/graph-schema.js';
import { validateGraph } from '../../../src/engines/control/graph-builder/validate.js';
import { compileGraphToConfig } from '../../../src/engines/control/graph-builder/compiler.js';

/**
 * H.3 regression — the few-shot templates must include a DelegatedKeyGrant per Agent.
 *
 * They originally did not, and the consequence was invisible rather than loud: every generated
 * fleet deployed to real agents with enforced policy but ZERO grant nodes, so `pendingGrants` came
 * back empty and the user was never prompted to sign the on-chain key grant. The fleet looked
 * fully deployed while having no Casper authority at all — the agents existed only as database
 * rows. Nothing failed; the on-chain half was simply never offered.
 *
 * These tests read the templates out of the real system prompt, so they cannot drift from what the
 * model is actually shown.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/engines/control/graph-builder/prompt-to-graph.ts', import.meta.url)),
  'utf8',
);

/** Pull the embedded example graphs out of the system prompt by brace-matching from each `{"nodes"`. */
function extractTemplateGraphs(): unknown[] {
  const graphs: unknown[] = [];
  for (let i = SOURCE.indexOf('{\n  "nodes"'); i !== -1; i = SOURCE.indexOf('{\n  "nodes"', i + 1)) {
    let depth = 0;
    for (let j = i; j < SOURCE.length; j += 1) {
      if (SOURCE[j] === '{') depth += 1;
      else if (SOURCE[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          // `<N>` is the prompt's money placeholder; substitute a real mote amount to parse.
          graphs.push(JSON.parse(SOURCE.slice(i, j + 1).replaceAll('"<N>"', '"60000000000"')));
          break;
        }
      }
    }
  }
  return graphs;
}

describe('H.3 few-shot templates', () => {
  const templates = extractTemplateGraphs();

  it('finds both reference templates in the system prompt', () => {
    expect(templates.length).toBe(2);
  });

  it('each template still parses against the real graph schema', () => {
    for (const t of templates) expect(() => GraphSchema.parse(t)).not.toThrow();
  });

  it('each template passes G.3 validation', () => {
    for (const t of templates) {
      const result = validateGraph(t);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it('gives EVERY agent a DelegatedKeyGrant — otherwise the on-chain step is never offered', () => {
    for (const t of templates) {
      const graph = GraphSchema.parse(t);
      const agentIds = graph.nodes.filter((n) => n.type === 'Agent').map((n) => n.id);
      const grantedRefs = graph.nodes
        .filter((n): n is Extract<typeof n, { type: 'DelegatedKeyGrant' }> => n.type === 'DelegatedKeyGrant')
        .map((n) => n.config.agentRef);

      expect(agentIds.length).toBeGreaterThan(0);
      expect([...grantedRefs].sort()).toEqual([...agentIds].sort());
    }
  });

  it('attaches every grant to its agent with an "attaches-to" edge', () => {
    for (const t of templates) {
      const graph = GraphSchema.parse(t);
      for (const grant of graph.nodes) {
        if (grant.type !== 'DelegatedKeyGrant') continue;
        const edge = graph.edges.find((e) => e.to === grant.id && e.kind === 'attaches-to');
        expect(edge, `grant ${grant.id} must attach to its agent`).toBeDefined();
        expect(edge!.from).toBe(grant.config.agentRef);
      }
    }
  });

  it('every grant is weight 1 and starts pending — never pre-marked as granted', () => {
    for (const t of templates) {
      const graph = GraphSchema.parse(t);
      for (const n of graph.nodes) {
        if (n.type !== 'DelegatedKeyGrant') continue;
        expect(n.config.weight).toBe(1);
        expect(n.config.status).toBe('pending');
      }
    }
  });

  it('compiles to a config carrying one grant intent per agent', () => {
    for (const t of templates) {
      const config = compileGraphToConfig(GraphSchema.parse(t));
      expect(config.grantIntents.length).toBe(config.flow.roles.length);
      for (const intent of config.grantIntents) expect(intent.status).toBe('pending');
    }
  });
});
