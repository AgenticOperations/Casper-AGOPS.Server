import { describe, it, expect } from 'vitest';
import type { Graph } from '../../../src/engines/control/graph-builder/graph-schema.js';
import { compileGraphToConfig } from '../../../src/engines/control/graph-builder/compiler.js';
import { compileTradingFlow, type TradingFlowDefinition } from '../../../src/engines/control/trading-flow.js';
import { compileEffectivePolicy } from '../../../src/engines/control/policy-compile.js';

/**
 * J.3 — "the canvas adds NO new enforcement path".
 *
 * The claim to prove is not that deploy succeeds, but that a fleet built on the canvas is governed
 * by exactly the same rules as the identical fleet built through the normal (non-canvas) path. If
 * the two produced different effective policy, the canvas would be a second, weaker authority —
 * the specific failure this milestone must rule out.
 *
 * So: express one fleet BOTH ways — as a canvas graph and as a `TradingFlowDefinition` — run each
 * through its own compiler, then through the SAME `compileEffectivePolicy` the proxy uses on the
 * hot path (see publish.ts), and require the enforced output to be identical.
 *
 * This runs without Postgres deliberately: the Docker-gated integration tests skip silently when
 * infra is absent, which is exactly how a regression here would slip through unnoticed.
 */

const ORG_CEILING = {
  totalBudget: 100_000_000n,
  perAgentMax: 60_000_000n,
  cooldownSeconds: 0,
  allowedDestinations: [] as string[],
};

/** The fleet as drawn on the canvas. */
function canvasGraph(): Graph {
  return {
    nodes: [
      {
        id: 'org-1',
        type: 'OrgCeiling',
        config: {
          totalBudget: ORG_CEILING.totalBudget.toString(),
          perAgentMax: ORG_CEILING.perAgentMax.toString(),
          cooldownSeconds: ORG_CEILING.cooldownSeconds,
          allowedDestinations: ORG_CEILING.allowedDestinations,
        },
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
    ],
    edges: [
      { from: 'org-1', to: 'fleet-1', kind: 'contains' },
      { from: 'fleet-1', to: 'flow-1', kind: 'contains' },
      { from: 'fleet-1', to: 'agent-1', kind: 'contains' },
      { from: 'flow-1', to: 'agent-1', kind: 'attaches-to' },
      { from: 'agent-1', to: 'guard-1', kind: 'governed-by' },
    ],
  };
}

/** The SAME fleet, expressed the normal (non-canvas) way. */
function sdkFlowDefinition(): TradingFlowDefinition {
  return {
    name: 'solo-swapper',
    version: 1,
    orgCeiling: ORG_CEILING,
    roles: [
      {
        role: 'trader',
        allowedActions: ['cspr-trade'],
        serviceScope: ['cspr.trade:swap'],
        subCap: 60_000_000n,
        velocityLimitPerHour: 10,
      },
    ],
  } as TradingFlowDefinition;
}

describe('J.3 canvas-deployed config is enforced identically to an SDK-created one', () => {
  it('produces the same effective policy through the proxy-side compiler', () => {
    const fromCanvas = compileGraphToConfig(canvasGraph());
    const fromSdk = compileTradingFlow(sdkFlowDefinition());

    const canvasRole = fromCanvas.flow.roles.find((r) => r.role === 'trader');
    const sdkRole = fromSdk.roles.find((r) => r.role === 'trader');
    expect(canvasRole).toBeDefined();
    expect(sdkRole).toBeDefined();

    const common = { agentId: 'ag-1', orgId: 'org-1', policyId: 'pol-1', policyEpoch: 1 } as const;

    // The canvas shares ONE org ceiling across roles; the SDK compiler carries a per-role
    // allocation. Both are handed to the same compiler as the root layer, agent layer last.
    const canvasEffective = compileEffectivePolicy({
      ...common,
      spendLayers: [canvasRole!.spend],
      allocationLayers: [fromCanvas.orgCeiling],
    });

    const sdkEffective = compileEffectivePolicy({
      ...common,
      spendLayers: [sdkRole!.spend],
      allocationLayers: [sdkRole!.allocation],
    });

    // The enforced envelope — what actually gates a payment — must be indistinguishable.
    expect(canvasEffective.spend).toEqual(sdkEffective.spend);
    expect(canvasEffective.allocation).toEqual(sdkEffective.allocation);
  });

  it('carries the drawn sub-cap into the enforced spend cap (not a wider one)', () => {
    const fromCanvas = compileGraphToConfig(canvasGraph());
    const role = fromCanvas.flow.roles.find((r) => r.role === 'trader')!;

    const effective = compileEffectivePolicy({
      agentId: 'ag-1',
      orgId: 'org-1',
      policyId: 'pol-1',
      policyEpoch: 1,
      spendLayers: [role.spend],
      allocationLayers: [fromCanvas.orgCeiling],
    });

    expect(effective.spend.spendCap).toBe(60_000_000n);
    // Never silently widened to the org total.
    expect(effective.spend.spendCap).toBeLessThanOrEqual(ORG_CEILING.perAgentMax);
  });

  it('narrows to the stricter layer when the org ceiling is tighter than the drawn sub-cap', () => {
    const fromCanvas = compileGraphToConfig(canvasGraph());
    const role = fromCanvas.flow.roles.find((r) => r.role === 'trader')!;

    // A tighter org-level spend layer must win over the agent's own cap — the most-restrictive
    // root->leaf intersection is what the proxy enforces, and the canvas must not bypass it.
    const orgSpendLayer = { ...role.spend, spendCap: 10_000_000n, perTransactionMax: 10_000_000n };

    const effective = compileEffectivePolicy({
      agentId: 'ag-1',
      orgId: 'org-1',
      policyId: 'pol-1',
      policyEpoch: 1,
      spendLayers: [orgSpendLayer, role.spend],
      allocationLayers: [fromCanvas.orgCeiling],
    });

    expect(effective.spend.spendCap).toBe(10_000_000n);
  });
});
