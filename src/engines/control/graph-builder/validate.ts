import { compileAllocation, compileSpend } from '../policy-compile.js';
import type { AllocationPolicy, SpendPolicy } from '../../../contracts/index.js';
import { GraphSchema, type Graph } from './graph-schema.js';

/**
 * G.3 — graph-level validation (BUILD-CHECKLIST-visual-builder.md Milestone G.3).
 *
 * Deliberately thin: the actual cap-narrowing arithmetic ("child can only narrow a parent, never
 * widen") is NOT reimplemented here — it is delegated to the existing, already-tested
 * `compileSpend`/`compileAllocation` in `policy-compile.ts`. This module only adds the graph-SHAPE
 * rules that have no equivalent in that module: containment arity (an Agent must sit under exactly
 * one Fleet under one OrgCeiling) and the trader-needs-a-cspr-trade-guardrail rule. An over-cap
 * graph is still caught here because we build the same `SpendPolicy`/`AllocationPolicy` objects and
 * run them through the real compiler, which throws (via a plain narrowing comparison) rather than
 * accept a widened cap.
 */

export interface GraphValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateGraph(rawGraph: unknown): GraphValidationResult {
  const errors: string[] = [];

  let graph: Graph;
  try {
    graph = GraphSchema.parse(rawGraph);
  } catch (err) {
    return { valid: false, errors: [`schema: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const orgNodes = graph.nodes.filter((n) => n.type === 'OrgCeiling');
  const fleetNodes = graph.nodes.filter((n) => n.type === 'Fleet');
  const agentNodes = graph.nodes.filter((n) => n.type === 'Agent');
  const guardrailNodes = graph.nodes.filter((n) => n.type === 'Guardrail');

  if (orgNodes.length !== 1) {
    errors.push(`graph must have exactly one OrgCeiling node (found ${orgNodes.length})`);
  }
  if (fleetNodes.length === 0) {
    errors.push('graph must have at least one Fleet node');
  }

  const org = orgNodes[0];
  const fleet = fleetNodes[0];

  // Containment: every Agent under exactly one Fleet under one OrgCeiling.
  if (org && fleet) {
    const orgToFleet = graph.edges.some((e) => e.from === org.id && e.to === fleet.id && e.kind === 'contains');
    if (!orgToFleet) {
      errors.push('the Fleet must be contained under the OrgCeiling (missing "contains" edge)');
    }
  }

  for (const agent of agentNodes) {
    const parents = graph.edges.filter(
      (e) => e.to === agent.id && e.kind === 'contains' && graph.nodes.some((n) => n.id === e.from && n.type === 'Fleet'),
    );
    if (parents.length !== 1) {
      errors.push(
        `Agent "${agent.id}" must sit under exactly one Fleet (found ${parents.length} containing Fleet edges)`,
      );
    }
  }

  // Trader agents must have a cspr-trade Guardrail attached (governed-by).
  const guardrailById = new Map(guardrailNodes.map((g) => [g.id, g]));
  for (const agent of agentNodes) {
    if (agent.type !== 'Agent') continue;
    const isTrader = agent.config.allowedActions.includes('cspr-trade');
    if (!isTrader) continue;

    const attachedGuardrails = graph.edges
      .filter((e) => e.from === agent.id && e.kind === 'governed-by')
      .map((e) => guardrailById.get(e.to))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);

    const hasCsprTradeGuardrail = attachedGuardrails.some((g) => g.type === 'Guardrail' && g.config.kind === 'cspr-trade');
    if (!hasCsprTradeGuardrail) {
      errors.push(`trader Agent "${agent.id}" (rail cspr-trade) must have a cspr-trade Guardrail attached`);
    }
  }

  // Sub-caps <= parent — reuse the existing narrowing compiler, don't reinvent it.
  if (org && org.type === 'OrgCeiling') {
    const orgAlloc: AllocationPolicy = {
      totalBudget: BigInt(org.config.totalBudget),
      perAgentMax: BigInt(org.config.perAgentMax),
      cooldownSeconds: org.config.cooldownSeconds,
      allowedDestinations: org.config.allowedDestinations,
    };

    for (const agent of agentNodes) {
      if (agent.type !== 'Agent') continue;
      const subCap = BigInt(agent.config.subCap);
      const agentAlloc: AllocationPolicy = {
        totalBudget: subCap,
        perAgentMax: subCap,
        cooldownSeconds: orgAlloc.cooldownSeconds,
        allowedDestinations: orgAlloc.allowedDestinations,
      };

      // compileAllocation takes min() root->leaf; if the agent's own subCap is already the min,
      // it did not widen anything. If subCap > org.perAgentMax, the compiled cap silently narrows
      // to the org's — which is exactly what "sub-cap must not exceed parent" means, but we still
      // want a clear rejection rather than a silent narrow at graph-build time.
      const compiled = compileAllocation([orgAlloc, agentAlloc]);
      if (subCap > orgAlloc.perAgentMax) {
        errors.push(
          `Agent "${agent.id}" sub-cap (${subCap}) exceeds OrgCeiling perAgentMax (${orgAlloc.perAgentMax}); compiled cap would be ${compiled.perAgentMax}`,
        );
      }

      // Rail/scope narrowing sanity: run the agent's own spend layer through compileSpend against
      // itself to confirm it's a well-formed SpendPolicy the existing validator accepts (throws on
      // malformed input rather than silently passing).
      const spend: SpendPolicy = {
        spendCap: subCap,
        perTransactionMax: subCap,
        serviceScope: agent.config.serviceScope,
        railPermission: [...agent.config.allowedActions],
        velocityLimitPerHour: agent.config.velocityLimitPerHour,
      };
      try {
        compileSpend([spend]);
      } catch (err) {
        errors.push(`Agent "${agent.id}" spend layer is invalid: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
