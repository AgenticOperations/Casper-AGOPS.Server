import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Graph } from '../../../src/engines/control/graph-builder/graph-schema.js';
import { deployGraph, GraphDeployError } from '../../../src/engines/control/graph-builder/deploy.js';

/**
 * J.1 — the deploy bridge. These tests pin the three things Deploy is allowed to do (create
 * agents, attach enforced policy, surface UNSIGNED grant handles) and, just as importantly, the
 * things it must never do: sign anything, or create anything from a graph that fails validation.
 */

function traderGraph(): Graph {
  return {
    nodes: [
      {
        id: 'org-1',
        type: 'OrgCeiling',
        config: { totalBudget: '100000000', perAgentMax: '60000000', cooldownSeconds: 0, allowedDestinations: [] },
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
      { id: 'guard-1', type: 'Guardrail', config: { kind: 'cspr-trade', slippageBps: 100, allowedPairs: ['CSPR/wETH'] } },
      { id: 'grant-1', type: 'DelegatedKeyGrant', config: { agentRef: 'agent-1', weight: 1, status: 'pending' } },
    ],
    edges: [
      { from: 'org-1', to: 'fleet-1', kind: 'contains' },
      { from: 'fleet-1', to: 'flow-1', kind: 'contains' },
      { from: 'fleet-1', to: 'agent-1', kind: 'contains' },
      { from: 'flow-1', to: 'agent-1', kind: 'attaches-to' },
      { from: 'agent-1', to: 'guard-1', kind: 'governed-by' },
      { from: 'agent-1', to: 'grant-1', kind: 'attaches-to' },
    ],
  };
}

function makeDeps() {
  let n = 0;
  const registerAgent = vi.fn(async (_pool: pg.Pool, params: { orgId: string; name?: string }) => {
    n += 1;
    return {
      agent: { id: `ag-${n}`, orgId: params.orgId, name: params.name ?? '', status: 'active' },
      apiKey: { token: `ag_live_secret_${n}`, hash: `hash-${n}` },
    };
  });
  const attachTradingFlow = vi.fn(
    async (
      _deps: unknown,
      input: { flow: { roles: Array<{ role: string }> }; roleAssignments: Record<string, string> },
    ) => {
      const roleAssignments: Record<string, { agentId: string; policyId: string }> = {};
      for (const r of input.flow.roles) {
        roleAssignments[r.role] = { agentId: input.roleAssignments[r.role]!, policyId: `pol-${r.role}` };
      }
      return { roleAssignments };
    },
  );
  // Stands in for the vault-backed keypair generator. A deployment with no vault passes
  // `provisionDelegatedKey: undefined`, which is the custodial path exercised separately below.
  const provisionDelegatedKey = vi.fn(async (agentId: string) => ({ publicKey: `01pub_${agentId}` }));

  return {
    pool: {} as pg.Pool,
    registerAgent: registerAgent as never,
    attachTradingFlow: attachTradingFlow as never,
    createPolicyVersion: vi.fn() as never,
    assignPolicy: vi.fn() as never,
    provisionDelegatedKey,
    _spies: { registerAgent, attachTradingFlow, provisionDelegatedKey },
  };
}

describe('J.1 deployGraph', () => {
  it('creates a real agent per Agent node and attaches enforced policy', async () => {
    const deps = makeDeps();
    const result = await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });

    expect(deps._spies.registerAgent).toHaveBeenCalledTimes(1);
    expect(deps._spies.attachTradingFlow).toHaveBeenCalledTimes(1);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ nodeId: 'agent-1', role: 'trader', agentId: 'ag-1', policyId: 'pol-trader' });
  });

  it('returns the one-time ag_ key so the operator can copy it', async () => {
    const deps = makeDeps();
    const result = await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });
    expect(result.agents[0]?.apiKey).toBe('ag_live_secret_1');
  });

  it('agents are created BEFORE policy is attached (never chain authority without a cap)', async () => {
    const deps = makeDeps();
    await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });
    const agentOrder = deps._spies.registerAgent.mock.invocationCallOrder[0]!;
    const attachOrder = deps._spies.attachTradingFlow.mock.invocationCallOrder[0]!;
    expect(agentOrder).toBeLessThan(attachOrder);
  });

  it('surfaces a DelegatedKeyGrant node as a PENDING grant — never as a completed one', async () => {
    const deps = makeDeps();
    const result = await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });
    expect(result.pendingGrants).toEqual([{ nodeId: 'grant-1', agentId: 'ag-1', agentName: 'trader' }]);
  });

  /**
   * Regression: deploy created agents but never provisioned their delegated keypair, so the
   * on-chain grant step failed with `no_delegated_key` — after the deploy had already reported
   * success. `POST /v1/agents` had always paired these two; the graph deploy path had not.
   */
  it('provisions a delegated keypair for every agent it creates', async () => {
    const deps = makeDeps();
    const result = await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });

    expect(deps._spies.provisionDelegatedKey).toHaveBeenCalledTimes(1);
    expect(deps._spies.provisionDelegatedKey).toHaveBeenCalledWith('ag-1');
    expect(result.agents[0]?.delegatedPublicKey).toBe('01pub_ag-1');
  });

  it('omits a grant whose agent has NO delegated key, rather than offering a doomed wallet prompt', async () => {
    // No vault configured → no keypair → grant-init would answer 409 no_delegated_key. The key is
    // OMITTED rather than set to undefined, matching how the route builds deps under
    // exactOptionalPropertyTypes.
    const { provisionDelegatedKey: _omitted, ...deps } = makeDeps();
    const result = await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.delegatedPublicKey).toBeUndefined();
    expect(result.pendingGrants).toEqual([]);
  });

  it('still creates the fleet when key provisioning fails — a vault blip must not lose the agents', async () => {
    const deps = makeDeps();
    deps.provisionDelegatedKey = vi.fn(async () => {
      throw new Error('vault unreachable');
    });

    const result = await deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: traderGraph() });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.policyId).toBe('pol-trader');
    expect(result.pendingGrants).toEqual([]);
  });

  it('rejects an invalid graph WITHOUT creating anything (fail closed)', async () => {
    const deps = makeDeps();
    const overCap = traderGraph();
    // subCap (90) now exceeds the org perAgentMax (60) — the real policy compiler must reject it.
    (overCap.nodes.find((n) => n.id === 'agent-1') as { config: { subCap: string } }).config.subCap = '90000000';

    await expect(
      deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: overCap }),
    ).rejects.toBeInstanceOf(GraphDeployError);
    expect(deps._spies.registerAgent).not.toHaveBeenCalled();
    expect(deps._spies.attachTradingFlow).not.toHaveBeenCalled();
  });

  it('rejects a trader with no guardrail without creating anything', async () => {
    const deps = makeDeps();
    const noGuard = traderGraph();
    noGuard.nodes = noGuard.nodes.filter((n) => n.id !== 'guard-1');
    noGuard.edges = noGuard.edges.filter((e) => e.to !== 'guard-1');

    await expect(deployGraph(deps, { orgId: 'org_x', graphId: 'bg_1', rawGraph: noGuard })).rejects.toBeInstanceOf(
      GraphDeployError,
    );
    expect(deps._spies.registerAgent).not.toHaveBeenCalled();
  });
});

describe('J.1 deploy safety — the server never signs', () => {
  it('deploy.ts references no signer, vault, or private-key material', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../src/engines/control/graph-builder/deploy.ts', import.meta.url)),
      'utf8',
    );
    // Strip comments: the header explains WHY signing is absent, and those words must not
    // trip the check that real signing code is absent.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['KeyVault', 'vault', 'signDeploy', 'privateKey', 'secretKey', 'sign(']) {
      expect(code).not.toContain(forbidden);
    }
  });
});
