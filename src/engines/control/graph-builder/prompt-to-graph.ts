import type Anthropic from '@anthropic-ai/sdk';
import { GraphSchema, type Graph } from './graph-schema.js';
import { validateGraph } from './validate.js';

/**
 * H — LLM prompt -> graph generator (BUILD-CHECKLIST-visual-builder.md Milestone H).
 *
 * SAFETY (H.4, non-negotiable): this module PROPOSES config only. It calls the Claude API
 * with schema-constrained tool-call output so the model can only emit a graph JSON matching
 * Milestone G's schema — never free-form code, and this module never authorizes on-chain
 * broadcast of anything. There is zero reference anywhere in this file to key-custody,
 * delegated-key-grant, or transaction-building machinery; Deploy is a separate, explicit user
 * action (Milestone J, out of scope here). A static grep test (prompt-to-graph-safety.test.ts)
 * enforces this — see that file for the exact forbidden-symbol list.
 *
 * H.1: server-side `promptToGraph(prompt)` — tool-call structured output constrained to the
 * graph schema.
 * H.2: generate -> validate -> self-correct loop — one correction pass on validation failure,
 * reusing Milestone G's `validateGraph` (deterministic) kept separate from generation
 * (non-deterministic).
 * H.3: few-shot on the D-5 fleet templates (Data+Risk+Trader, Solo Swapper) so the model
 * anchors on real, valid shapes.
 */

const GRAPH_TOOL_NAME = 'emit_graph';

/**
 * The graph schema expressed as JSON Schema for the tool's input_schema. Kept in sync with
 * graph-schema.ts by hand (Zod doesn't have a built-in JSON-Schema exporter wired up here);
 * the emitted graph is still re-validated against the real Zod schema after generation, so an
 * out-of-sync tool schema fails closed at validation rather than silently accepting bad shape.
 */
const GRAPH_JSON_SCHEMA: Anthropic.Messages.Tool.InputSchema = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'OrgCeiling',
              'Fleet',
              'Agent',
              'Guardrail',
              'TradingFlow',
              'DelegatedKeyGrant',
              'ServiceRail',
            ],
          },
          config: { type: 'object' },
        },
        required: ['id', 'type', 'config'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string', enum: ['contains', 'governed-by', 'attaches-to'] },
        },
        required: ['from', 'to', 'kind'],
      },
    },
  },
  required: ['nodes', 'edges'],
};

// H.3: few-shot examples anchored on the D-5 fleet templates (data-risk-trader, solo-swapper),
// expressed as example graphs — not prose descriptions — so the model sees real, valid shapes.
const FEW_SHOT_SYSTEM_PROMPT = `You translate a natural-language description of an AgentOps trading fleet into a
validated config graph. You NEVER emit free-form code or prose — you ONLY call the ${GRAPH_TOOL_NAME} tool with a
graph matching the schema. The graph is a CONFIG SURFACE, not a runtime engine: edges express containment/attachment
("is governed by / belongs to"), never execution order ("then run").

Node types: OrgCeiling, Fleet, Agent, Guardrail, TradingFlow, DelegatedKeyGrant, ServiceRail.
Every Agent must sit under exactly one Fleet under one OrgCeiling. Agent sub-caps must not exceed the OrgCeiling's
perAgentMax. A trader Agent (one whose allowedActions includes "cspr-trade") MUST have a cspr-trade Guardrail
attached via a "governed-by" edge.

Two reference fleet template shapes (few-shot; anchor your output on these when the prompt is close to one):

Template "data-risk-trader" — a data agent + risk agent (casper-x402 only) feeding a trader (cspr-trade only):
{
  "nodes": [
    {"id":"org-1","type":"OrgCeiling","config":{"totalBudget":"<N>","perAgentMax":"<N>","cooldownSeconds":0,"allowedDestinations":[]}},
    {"id":"fleet-1","type":"Fleet","config":{"name":"data-risk-trader"}},
    {"id":"agent-data","type":"Agent","config":{"name":"data","role":"data","allowedActions":["casper-x402"],"serviceScope":["svc:market-data"],"subCap":"<N>","velocityLimitPerHour":60}},
    {"id":"agent-risk","type":"Agent","config":{"name":"risk","role":"risk","allowedActions":["casper-x402"],"serviceScope":["svc:risk-oracle"],"subCap":"<N>","velocityLimitPerHour":30}},
    {"id":"agent-trader","type":"Agent","config":{"name":"trader","role":"trader","allowedActions":["cspr-trade"],"serviceScope":["cspr.trade:swap"],"subCap":"<N>","velocityLimitPerHour":10}},
    {"id":"guard-trader","type":"Guardrail","config":{"kind":"cspr-trade","slippageBps":100,"allowedPairs":["CSPR/wETH"]}}
  ],
  "edges": [
    {"from":"org-1","to":"fleet-1","kind":"contains"},
    {"from":"fleet-1","to":"agent-data","kind":"contains"},
    {"from":"fleet-1","to":"agent-risk","kind":"contains"},
    {"from":"fleet-1","to":"agent-trader","kind":"contains"},
    {"from":"agent-trader","to":"guard-trader","kind":"governed-by"}
  ]
}

Template "solo-swapper" — a single trading agent with guardrails:
{
  "nodes": [
    {"id":"org-1","type":"OrgCeiling","config":{"totalBudget":"<N>","perAgentMax":"<N>","cooldownSeconds":0,"allowedDestinations":[]}},
    {"id":"fleet-1","type":"Fleet","config":{"name":"solo-swapper"}},
    {"id":"agent-trader","type":"Agent","config":{"name":"trader","role":"trader","allowedActions":["cspr-trade"],"serviceScope":["cspr.trade:swap"],"subCap":"<N>","velocityLimitPerHour":10}},
    {"id":"guard-trader","type":"Guardrail","config":{"kind":"cspr-trade","slippageBps":100}}
  ],
  "edges": [
    {"from":"org-1","to":"fleet-1","kind":"contains"},
    {"from":"fleet-1","to":"agent-trader","kind":"contains"},
    {"from":"agent-trader","to":"guard-trader","kind":"governed-by"}
  ]
}

Money amounts (totalBudget, perAgentMax, subCap) are base-unit decimal STRINGS (motes), never floats. When the
prompt gives CSPR amounts, multiply by 1_000_000_000 (9 decimals) to get motes.`;

export interface PromptToGraphInput {
  prompt: string;
}

export type PromptToGraphResult = { ok: true; graph: Graph } | { ok: false; error: string };

function extractGraphToolInput(response: Anthropic.Messages.Message): unknown {
  const toolUse = response.content.find(
    (block): block is Extract<Anthropic.Messages.ContentBlock, { type: 'tool_use' }> =>
      block.type === 'tool_use' && block.name === GRAPH_TOOL_NAME,
  );
  return toolUse?.input;
}

async function generateOnce(
  client: Anthropic,
  prompt: string,
  priorErrors?: string[],
): Promise<unknown> {
  const userContent = priorErrors?.length
    ? `${prompt}\n\nYour previous attempt failed validation with these errors:\n${priorErrors
        .map((e) => `- ${e}`)
        .join('\n')}\nProduce a corrected graph that fixes every error.`
    : prompt;

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    system: FEW_SHOT_SYSTEM_PROMPT,
    tools: [
      {
        name: GRAPH_TOOL_NAME,
        description: 'Emit the AgentOps config graph matching the schema. Config only — never code, never a signature.',
        input_schema: GRAPH_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: GRAPH_TOOL_NAME },
    messages: [{ role: 'user', content: userContent }],
  });

  return extractGraphToolInput(response);
}

/**
 * H.1/H.2: prompt -> validated graph. Generates once; on validation failure, feeds the errors
 * back to the model for exactly ONE correction pass; if that also fails, returns a clear
 * "need more info" result rather than ever handing back an invalid graph.
 */
export async function promptToGraph(
  client: Anthropic,
  input: PromptToGraphInput,
): Promise<PromptToGraphResult> {
  const firstAttempt = await generateOnce(client, input.prompt);
  const firstValidation = validateGraph(firstAttempt);
  if (firstValidation.valid) {
    return { ok: true, graph: GraphSchema.parse(firstAttempt) };
  }

  const secondAttempt = await generateOnce(client, input.prompt, firstValidation.errors);
  const secondValidation = validateGraph(secondAttempt);
  if (secondValidation.valid) {
    return { ok: true, graph: GraphSchema.parse(secondAttempt) };
  }

  return {
    ok: false,
    error: `Could not produce a valid graph after one self-correction pass — need more info. Remaining validation errors: ${secondValidation.errors.join('; ')}`,
  };
}
