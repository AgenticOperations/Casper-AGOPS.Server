import { GraphSchema, type Graph } from './graph-schema.js';
import { validateGraph } from './validate.js';

/**
 * H — LLM prompt -> graph generator (BUILD-CHECKLIST-visual-builder.md Milestone H).
 *
 * SAFETY (H.4, non-negotiable): this module PROPOSES config only. It asks Gemini for
 * JSON-only output and then re-validates that output against Milestone G's Zod schema —
 * never free-form code, and this module never authorizes on-chain broadcast of anything.
 * There is zero reference anywhere in this file to key-custody, delegated-key-grant, or
 * transaction-building machinery; Deploy is a separate, explicit user action (Milestone J,
 * out of scope here). A static grep test (prompt-to-graph-safety.test.ts) enforces this —
 * see that file for the exact forbidden-symbol list.
 *
 * H.1: server-side `promptToGraph(prompt)` — JSON-constrained structured output.
 * H.2: generate -> validate -> self-correct loop — one correction pass on validation failure,
 * reusing Milestone G's `validateGraph` (deterministic) kept separate from generation
 * (non-deterministic).
 * H.3: few-shot on the D-5 fleet templates (Data+Risk+Trader, Solo Swapper) so the model
 * anchors on real, valid shapes.
 *
 * Why no Gemini `responseSchema`: a node's `config` is a discriminated union keyed on
 * `node.type`, which Gemini's response schema cannot express. The two encodable alternatives
 * both lose: a bare `{type: OBJECT}` makes Gemini emit `config: {}` and drop every field, and
 * an all-optional superset of every type's fields measurably degrades output (the model then
 * omits required fields such as `allowedActions` and `velocityLimitPerHour`). Both were
 * measured against this prompt before choosing. So the wire contract is `responseMimeType:
 * application/json` plus the few-shot shapes below, and `GraphSchema` stays the sole
 * authority — malformed output fails closed at validation and re-enters the H.2 correction
 * pass rather than reaching the canvas.
 */

/** Minimal structural view of `@google/genai`'s client — kept narrow so tests inject a fake. */
export interface GraphModelClient {
  models: {
    generateContent(request: {
      model: string;
      contents: string;
      config: {
        systemInstruction: string;
        responseMimeType: string;
        temperature: number;
      };
    }): Promise<{ text?: string | undefined }>;
  };
}

export const DEFAULT_GRAPH_MODEL = 'gemini-3.6-flash';

// H.3: few-shot examples anchored on the D-5 fleet templates (data-risk-trader, solo-swapper),
// expressed as example graphs — not prose descriptions — so the model sees real, valid shapes.
const FEW_SHOT_SYSTEM_PROMPT = `You translate a natural-language description of an AgentOps trading fleet into a
validated config graph. You NEVER emit free-form code, prose, or markdown — you emit ONLY a single JSON object
matching the schema below. The graph is a CONFIG SURFACE, not a runtime engine: edges express containment/attachment
("is governed by / belongs to"), never execution order ("then run").

The JSON object has exactly two keys:
  "nodes": [{ "id": string, "type": NodeType, "config": object }]
  "edges": [{ "from": nodeId, "to": nodeId, "kind": "contains" | "governed-by" | "attaches-to" }]

NodeType is one of: OrgCeiling, Fleet, Agent, Guardrail, TradingFlow, DelegatedKeyGrant, ServiceRail.

Set EXACTLY the config fields belonging to that node's type — no others, and never omit one:
  OrgCeiling        totalBudget, perAgentMax, cooldownSeconds, allowedDestinations
  Fleet             name
  Agent             name, role, allowedActions, serviceScope, subCap, velocityLimitPerHour
  Guardrail         kind, and optionally slippageBps, allowedPairs, riskLabels
  TradingFlow       name, version
  DelegatedKeyGrant agentRef, weight (always 1), status ("pending" | "granted" | "revoked")
  ServiceRail       resourceId, destination

allowedActions entries and Guardrail "kind" must come from: raw-x402, circle-nano, casper-x402, cspr-trade,
casper-deploy, evm-transfer.

Every Agent must sit under exactly one Fleet under one OrgCeiling. Agent sub-caps must not exceed the OrgCeiling's
perAgentMax. A trader Agent (one whose allowedActions includes "cspr-trade") MUST have a cspr-trade Guardrail
attached via a "governed-by" edge.

EVERY Agent MUST also have its own DelegatedKeyGrant, attached with an "attaches-to" edge from the Agent to the
grant, with "agentRef" set to that Agent's NODE id and "status":"pending". Without it the agent has no on-chain
authority to act with — it would exist only as a database row, and the user would never be prompted to sign the
key grant that makes it real on Casper. Emit one grant per Agent, always.

Two reference fleet template shapes (few-shot; anchor your output on these when the prompt is close to one):

Template "data-risk-trader" — a data agent + risk agent (casper-x402 only) feeding a trader (cspr-trade only):
{
  "nodes": [
    {"id":"org-1","type":"OrgCeiling","config":{"totalBudget":"<N>","perAgentMax":"<N>","cooldownSeconds":0,"allowedDestinations":[]}},
    {"id":"fleet-1","type":"Fleet","config":{"name":"data-risk-trader"}},
    {"id":"agent-data","type":"Agent","config":{"name":"data","role":"data","allowedActions":["casper-x402"],"serviceScope":["svc:market-data"],"subCap":"<N>","velocityLimitPerHour":60}},
    {"id":"agent-risk","type":"Agent","config":{"name":"risk","role":"risk","allowedActions":["casper-x402"],"serviceScope":["svc:risk-oracle"],"subCap":"<N>","velocityLimitPerHour":30}},
    {"id":"agent-trader","type":"Agent","config":{"name":"trader","role":"trader","allowedActions":["cspr-trade"],"serviceScope":["cspr.trade:swap"],"subCap":"<N>","velocityLimitPerHour":10}},
    {"id":"guard-trader","type":"Guardrail","config":{"kind":"cspr-trade","slippageBps":100,"allowedPairs":["CSPR/wETH"]}},
    {"id":"grant-data","type":"DelegatedKeyGrant","config":{"agentRef":"agent-data","weight":1,"status":"pending"}},
    {"id":"grant-risk","type":"DelegatedKeyGrant","config":{"agentRef":"agent-risk","weight":1,"status":"pending"}},
    {"id":"grant-trader","type":"DelegatedKeyGrant","config":{"agentRef":"agent-trader","weight":1,"status":"pending"}}
  ],
  "edges": [
    {"from":"org-1","to":"fleet-1","kind":"contains"},
    {"from":"fleet-1","to":"agent-data","kind":"contains"},
    {"from":"fleet-1","to":"agent-risk","kind":"contains"},
    {"from":"fleet-1","to":"agent-trader","kind":"contains"},
    {"from":"agent-trader","to":"guard-trader","kind":"governed-by"},
    {"from":"agent-data","to":"grant-data","kind":"attaches-to"},
    {"from":"agent-risk","to":"grant-risk","kind":"attaches-to"},
    {"from":"agent-trader","to":"grant-trader","kind":"attaches-to"}
  ]
}

Template "solo-swapper" — a single trading agent with guardrails:
{
  "nodes": [
    {"id":"org-1","type":"OrgCeiling","config":{"totalBudget":"<N>","perAgentMax":"<N>","cooldownSeconds":0,"allowedDestinations":[]}},
    {"id":"fleet-1","type":"Fleet","config":{"name":"solo-swapper"}},
    {"id":"agent-trader","type":"Agent","config":{"name":"trader","role":"trader","allowedActions":["cspr-trade"],"serviceScope":["cspr.trade:swap"],"subCap":"<N>","velocityLimitPerHour":10}},
    {"id":"guard-trader","type":"Guardrail","config":{"kind":"cspr-trade","slippageBps":100}},
    {"id":"grant-trader","type":"DelegatedKeyGrant","config":{"agentRef":"agent-trader","weight":1,"status":"pending"}}
  ],
  "edges": [
    {"from":"org-1","to":"fleet-1","kind":"contains"},
    {"from":"fleet-1","to":"agent-trader","kind":"contains"},
    {"from":"agent-trader","to":"guard-trader","kind":"governed-by"},
    {"from":"agent-trader","to":"grant-trader","kind":"attaches-to"}
  ]
}

Money amounts (totalBudget, perAgentMax, subCap) are base-unit decimal STRINGS (motes), never floats. When the
prompt gives CSPR amounts, multiply by 1_000_000_000 (9 decimals) to get motes.`;

export interface PromptToGraphInput {
  prompt: string;
  /** Overrides DEFAULT_GRAPH_MODEL; wired from env.GEMINI_GRAPH_MODEL by the route. */
  model?: string;
}

export type PromptToGraphResult = { ok: true; graph: Graph } | { ok: false; error: string };

/**
 * `responseMimeType: application/json` normally yields bare JSON, but a model can still wrap it
 * in a markdown fence. Strip one if present, then parse. Returns `undefined` on anything
 * unparseable so the caller treats it as a failed attempt rather than throwing.
 */
function parseGraphJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

async function generateOnce(
  client: GraphModelClient,
  input: PromptToGraphInput,
  priorErrors?: string[],
): Promise<unknown> {
  const userContent = priorErrors?.length
    ? `${input.prompt}\n\nYour previous attempt failed validation with these errors:\n${priorErrors
        .map((e) => `- ${e}`)
        .join('\n')}\nProduce a corrected graph that fixes every error.`
    : input.prompt;

  const response = await client.models.generateContent({
    model: input.model ?? DEFAULT_GRAPH_MODEL,
    contents: userContent,
    config: {
      systemInstruction: FEW_SHOT_SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      // Deterministic generation: this is config synthesis against a fixed schema, not prose.
      temperature: 0,
    },
  });

  return parseGraphJson(response.text);
}

/**
 * H.1/H.2: prompt -> validated graph. Generates once; on validation failure, feeds the errors
 * back to the model for exactly ONE correction pass; if that also fails, returns a clear
 * "need more info" result rather than ever handing back an invalid graph.
 */
export async function promptToGraph(
  client: GraphModelClient,
  input: PromptToGraphInput,
): Promise<PromptToGraphResult> {
  const firstAttempt = await generateOnce(client, input);
  const firstValidation = validateGraph(firstAttempt);
  if (firstValidation.valid) {
    return { ok: true, graph: GraphSchema.parse(firstAttempt) };
  }

  const secondAttempt = await generateOnce(client, input, firstValidation.errors);
  const secondValidation = validateGraph(secondAttempt);
  if (secondValidation.valid) {
    return { ok: true, graph: GraphSchema.parse(secondAttempt) };
  }

  return {
    ok: false,
    error: `Could not produce a valid graph after one self-correction pass — need more info. Remaining validation errors: ${secondValidation.errors.join('; ')}`,
  };
}
