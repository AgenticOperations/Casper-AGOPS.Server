import { z } from 'zod';

/**
 * G.1 — the canonical graph model (RESEARCH-visual-workflow-builder.md §2.1, §3.1;
 * BUILD-CHECKLIST-visual-builder.md Milestone G.1).
 *
 * The canvas is a CONFIG SURFACE, not a runtime engine. Every node type maps 1:1 to a real
 * AgentOps object (org ceiling, fleet, agent, guardrail, trading flow, delegated-key grant,
 * service/rail). Edges express containment/attachment ("is governed by / belongs to") — NEVER
 * "then run". `EDGE_KINDS` below is the exhaustive, closed set; any other kind (e.g. "then-run",
 * "next", "pipes-to") is rejected at the schema boundary so an execution-order edge can never even
 * parse.
 */

// A bigint-like base-units amount, transported as a decimal string on the wire (never a float).
const baseUnitsString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string (base units)');

const railPermissionSchema = z.enum([
  'raw-x402',
  'circle-nano',
  'casper-x402',
  'cspr-trade',
  'casper-deploy',
  'evm-transfer',
]);

// ── Node config schemas (one per node type, per checklist G.1) ─────────────────────────────────

const OrgCeilingConfigSchema = z.object({
  totalBudget: baseUnitsString,
  perAgentMax: baseUnitsString,
  cooldownSeconds: z.number().int().min(0),
  allowedDestinations: z.array(z.string()),
});

const FleetConfigSchema = z.object({
  name: z.string().min(1),
});

const AgentConfigSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  allowedActions: z.array(railPermissionSchema).min(1),
  serviceScope: z.array(z.string()),
  subCap: baseUnitsString,
  velocityLimitPerHour: z.number().int().min(0),
});

const GuardrailConfigSchema = z.object({
  kind: railPermissionSchema,
  slippageBps: z.number().int().min(0).max(10_000).optional(),
  allowedPairs: z.array(z.string()).optional(),
  riskLabels: z.array(z.string()).optional(),
});

const TradingFlowConfigSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().min(1),
});

const DelegatedKeyGrantConfigSchema = z.object({
  agentRef: z.string().min(1),
  weight: z.literal(1),
  status: z.enum(['pending', 'granted', 'revoked']),
});

const ServiceRailConfigSchema = z.object({
  resourceId: z.string().min(1),
  destination: z.string().min(1),
});

export const NodeSchemaByType = {
  OrgCeiling: z.object({ id: z.string().min(1), type: z.literal('OrgCeiling'), config: OrgCeilingConfigSchema }),
  Fleet: z.object({ id: z.string().min(1), type: z.literal('Fleet'), config: FleetConfigSchema }),
  Agent: z.object({ id: z.string().min(1), type: z.literal('Agent'), config: AgentConfigSchema }),
  Guardrail: z.object({ id: z.string().min(1), type: z.literal('Guardrail'), config: GuardrailConfigSchema }),
  TradingFlow: z.object({ id: z.string().min(1), type: z.literal('TradingFlow'), config: TradingFlowConfigSchema }),
  DelegatedKeyGrant: z.object({
    id: z.string().min(1),
    type: z.literal('DelegatedKeyGrant'),
    config: DelegatedKeyGrantConfigSchema,
  }),
  ServiceRail: z.object({ id: z.string().min(1), type: z.literal('ServiceRail'), config: ServiceRailConfigSchema }),
} as const;

export type NodeType = keyof typeof NodeSchemaByType;

export const NODE_TYPES = Object.keys(NodeSchemaByType) as NodeType[];

export const GraphNodeSchema = z.discriminatedUnion('type', [
  NodeSchemaByType.OrgCeiling,
  NodeSchemaByType.Fleet,
  NodeSchemaByType.Agent,
  NodeSchemaByType.Guardrail,
  NodeSchemaByType.TradingFlow,
  NodeSchemaByType.DelegatedKeyGrant,
  NodeSchemaByType.ServiceRail,
]);

export type GraphNode = z.infer<typeof GraphNodeSchema>;

/**
 * The closed set of edge kinds. All express containment/attachment, never execution order.
 * "contains"     — a parent config object structurally contains a child (OrgCeiling->Fleet,
 *                   Fleet->Agent, TradingFlow->Agent).
 * "governed-by"  — a node's behaviour is bounded by another (Agent->Guardrail).
 * "attaches-to"  — a flow/grant/rail attaches to an agent (Agent->DelegatedKeyGrant,
 *                   Agent->ServiceRail, TradingFlow->Agent).
 */
export const EDGE_KINDS = ['contains', 'governed-by', 'attaches-to'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(EDGE_KINDS),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

export type Graph = z.infer<typeof GraphSchema>;
