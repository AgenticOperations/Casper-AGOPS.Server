import type pg from 'pg';
import { validateGraph } from './validate.js';
import { compileGraphToConfig, type CompiledGraphConfig } from './compiler.js';
import { GraphSchema } from './graph-schema.js';
import type { CompiledTradingFlow } from '../trading-flow.js';
import type { registerAgent, createPolicyVersion, assignPolicy } from '../store.js';
import type { attachTradingFlow } from '../attach-trading-flow.js';

/**
 * J.1 — the deploy bridge (BUILD-CHECKLIST-visual-builder.md Milestone J).
 *
 * This is the step that makes a canvas graph REAL, and it is the first and only caller of
 * `compileGraphToConfig` on a runtime path — until now that compiler existed with no production
 * consumer at all.
 *
 * What "deploy" means here, precisely (the canvas is a CONFIG SURFACE, not a workflow engine —
 * non-negotiable rule #1 of the checklist). Deploy does NOT start, schedule, or orchestrate
 * anything. No node ever "runs". It performs exactly three effects:
 *
 *   1. Creates real agents        (Postgres `agents` + a one-time ag_ key per Agent node)
 *   2. Writes ENFORCED policy     (Postgres policy versions + assignments, via attachTradingFlow)
 *   3. Prepares on-chain grants   (returns UNSIGNED deploy handles — never signs)
 *
 * Effect 3 is deliberately only a *preparation*. The `update_associated_keys` deploy that gives an
 * agent on-chain authority must be signed by the user's master key in the browser (CSPR.click) via
 * the existing `/v1/agents/:id/grant-delegated-key/init|confirm` routes. GLOBAL RULE #1: this
 * module imports no vault, no signer, and no private-key material, and must never do so — the
 * safety test asserts that statically.
 *
 * Ordering matters and is not arbitrary: agents must exist before policy can be assigned to them,
 * and policy must be enforced BEFORE any key is granted on-chain. Granting first would open a
 * window where an agent holds chain authority with no spend cap attached to it.
 */

export interface DeployGraphDeps {
  pool: pg.Pool;
  registerAgent: typeof registerAgent;
  attachTradingFlow: typeof attachTradingFlow;
  /** Passed straight through to attachTradingFlow; injected so tests can substitute fakes. */
  createPolicyVersion: typeof createPolicyVersion;
  assignPolicy: typeof assignPolicy;
  /**
   * Provisions the agent's proxy-side delegated keypair (vault-generated public key + the
   * `delegated_keys` row). Absent when no vault is configured — the agent then stays custodial,
   * exactly as `POST /v1/agents` behaves without a vault.
   *
   * This is NOT a signer and holds no user key material: it generates the AGENT's own keypair
   * inside the vault. The user's master key is never involved here — it signs the on-chain grant
   * later, in the browser.
   */
  provisionDelegatedKey?: (agentId: string) => Promise<{ publicKey: string }>;
}

export interface DeployedAgent {
  /** The canvas node id this agent came from, so the client can map it back onto the graph. */
  nodeId: string;
  role: string;
  agentId: string;
  name: string;
  /** Returned ONCE, never persisted in plaintext, never logged. */
  apiKey: string;
  policyId: string;
  /** Present only when a vault is wired; the proxy-side half of the delegated key. */
  delegatedPublicKey?: string;
}

export interface DeployGraphResult {
  graphId: string;
  fleetName: string;
  agents: DeployedAgent[];
  /**
   * Agents whose DelegatedKeyGrant node means they still need the user's master key to sign the
   * on-chain `update_associated_keys` deploy. The client drives these through the EXISTING
   * grant-init/confirm signing dialog. Empty when the graph declares no grants.
   */
  pendingGrants: Array<{ nodeId: string; agentId: string; agentName: string }>;
}

export class GraphDeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'GraphDeployError';
  }
}

/**
 * Bridge the graph compiler's output to the shape `attachTradingFlow` consumes.
 *
 * `compileGraphToConfig` produces a per-role `spend` policy but no `allocation` — on the canvas
 * the allocation ceiling is authored ONCE on the OrgCeiling node and shared by every role, whereas
 * `CompiledTradingFlow` carries one per role. We therefore hand each role the same org ceiling
 * rather than inventing a per-role one: the effective policy is compiled as the most-restrictive
 * root→leaf intersection, so a shared ceiling narrowed by each role's own spend cap yields exactly
 * the envelope the user drew.
 */
function toCompiledTradingFlow(config: CompiledGraphConfig): CompiledTradingFlow {
  return {
    name: config.flow.name,
    version: config.flow.version,
    roles: config.flow.roles.map((role) => ({
      role: role.role,
      allowedActions: role.allowedActions,
      spend: role.spend,
      allocation: config.orgCeiling,
    })),
  };
}

/**
 * Compile + deploy a canvas graph. Rejects an invalid graph BEFORE creating anything, so a
 * validation failure can never leave half a fleet behind.
 */
export async function deployGraph(
  deps: DeployGraphDeps,
  input: { orgId: string; graphId: string; rawGraph: unknown; name?: string },
): Promise<DeployGraphResult> {
  // Fail closed on the same authority the proxy uses (G.3) — never a parallel rule set.
  const validation = validateGraph(input.rawGraph);
  if (!validation.valid) {
    throw new GraphDeployError('graph failed validation', 'invalid_graph', validation.errors);
  }

  const graph = GraphSchema.parse(input.rawGraph);
  const config = compileGraphToConfig(graph);

  // Map each compiled role back to the Agent NODE that produced it. compileGraphToConfig emits
  // roles in graph node order, but matching by role name is order-independent and survives any
  // future reordering inside the compiler.
  const agentNodes = graph.nodes.filter((n): n is Extract<typeof n, { type: 'Agent' }> => n.type === 'Agent');
  const nodeIdByRole = new Map(agentNodes.map((n) => [n.config.role, n.id]));

  // 1. Create the real agents. Each returns its ag_ key exactly once, and each is immediately
  //    given its proxy-side delegated keypair — the same pairing `POST /v1/agents` performs.
  //    Without the keypair the agent has no public key to associate, so the on-chain grant step
  //    fails later with `no_delegated_key` even though the deploy itself reported success.
  const created: Array<{
    nodeId: string;
    role: string;
    agentId: string;
    name: string;
    apiKey: string;
    delegatedPublicKey?: string;
  }> = [];

  for (const role of config.flow.roles) {
    const nodeId = nodeIdByRole.get(role.role);
    if (!nodeId) {
      throw new GraphDeployError(`no Agent node for compiled role "${role.role}"`, 'role_node_missing');
    }
    const { agent, apiKey } = await deps.registerAgent(deps.pool, {
      orgId: input.orgId,
      name: role.agentName,
    });

    // Mirrors agent-routes.ts: a vault blip must NOT fail agent creation. The agent stays
    // custodial and the key can be provisioned later, rather than losing the whole fleet.
    let delegatedPublicKey: string | undefined;
    if (deps.provisionDelegatedKey) {
      try {
        delegatedPublicKey = (await deps.provisionDelegatedKey(agent.id)).publicKey;
      } catch {
        delegatedPublicKey = undefined;
      }
    }

    created.push({
      nodeId,
      role: role.role,
      agentId: agent.id,
      name: role.agentName,
      apiKey: apiKey.token,
      ...(delegatedPublicKey ? { delegatedPublicKey } : {}),
    });
  }

  // 2. Attach the compiled flow — this is the step with actual teeth. It writes append-only policy
  //    versions and assigns each role's spend policy to its agent, through the SAME policy system
  //    the proxy already enforces on every authorization (J.3: no new enforcement path).
  const roleAssignments: Record<string, string> = {};
  for (const c of created) roleAssignments[c.role] = c.agentId;

  const attached = await deps.attachTradingFlow(
    { pool: deps.pool, createPolicyVersion: deps.createPolicyVersion, assignPolicy: deps.assignPolicy },
    { orgId: input.orgId, flow: toCompiledTradingFlow(config), roleAssignments },
  );

  const agents: DeployedAgent[] = created.map((c) => ({
    nodeId: c.nodeId,
    role: c.role,
    agentId: c.agentId,
    name: c.name,
    apiKey: c.apiKey,
    policyId: attached.roleAssignments[c.role]?.policyId ?? '',
    ...(c.delegatedPublicKey ? { delegatedPublicKey: c.delegatedPublicKey } : {}),
  }));

  // 3. Surface the grants that still need a master-key signature. We return handles only — the
  //    unsigned deploy itself comes from the existing grant-init route, which already owns the
  //    account-hash derivation and the WASM bytes. No signing happens anywhere in this module.
  const agentIdByNodeId = new Map(agents.map((a) => [a.nodeId, a]));
  const pendingGrants: DeployGraphResult['pendingGrants'] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'DelegatedKeyGrant') continue;
    const target = agentIdByNodeId.get(node.config.agentRef);
    // Only offer to sign a grant for an agent that HAS a delegated key. Listing one without a key
    // sends the user to a wallet prompt that can only fail with `no_delegated_key` — better to
    // omit it than to promise an action the backend will refuse.
    if (target?.delegatedPublicKey) {
      pendingGrants.push({ nodeId: node.id, agentId: target.agentId, agentName: target.name });
    }
  }

  return { graphId: input.graphId, fleetName: config.fleetName, agents, pendingGrants };
}
