import { describe, it, expect } from 'vitest';
import {
  compileTradingFlow,
  FLEET_TEMPLATES,
  instantiateFleetTemplate,
} from '../../src/engines/control/trading-flow.js';

describe('compileTradingFlow (D.1 — flow compiles to existing policy objects)', () => {
  it('compiles each role into a SpendPolicy the existing validator already accepts', () => {
    const flow = {
      name: 'test-flow',
      version: 1,
      orgCeiling: { totalBudget: 10000n, perAgentMax: 2000n, cooldownSeconds: 60, allowedDestinations: ['*'] },
      roles: [
        {
          role: 'data',
          allowedActions: ['casper-x402'] as const,
          serviceScope: ['svc:market-data'],
          subCap: 500n,
          velocityLimitPerHour: 10,
        },
        {
          role: 'trader',
          allowedActions: ['cspr-trade'] as const,
          serviceScope: ['cspr.trade:swap'],
          subCap: 2000n,
          velocityLimitPerHour: 5,
        },
      ],
    };

    const compiled = compileTradingFlow(flow);

    expect(compiled.roles).toHaveLength(2);
    const dataRole = compiled.roles.find((r) => r.role === 'data')!;
    expect(dataRole.spend.railPermission).toEqual(['casper-x402']);
    expect(dataRole.spend.serviceScope).toEqual(['svc:market-data']);
    expect(dataRole.spend.perTransactionMax).toBe(500n);
    expect(dataRole.allocation.totalBudget).toBe(10000n);
    expect(dataRole.allocation.perAgentMax).toBe(2000n);
  });

  it('rejects a flow whose per-agent sub-caps could exceed the org ceiling perAgentMax (D-5④ existing enforcement, not a new primitive)', () => {
    const flow = {
      name: 'over-cap-flow',
      version: 1,
      orgCeiling: { totalBudget: 10000n, perAgentMax: 1000n, cooldownSeconds: 60, allowedDestinations: ['*'] },
      roles: [
        {
          role: 'trader',
          allowedActions: ['cspr-trade'] as const,
          serviceScope: ['cspr.trade:swap'],
          subCap: 5000n, // exceeds perAgentMax
          velocityLimitPerHour: 5,
        },
      ],
    };

    expect(() => compileTradingFlow(flow)).toThrow(/exceeds org perAgentMax/i);
  });
});

describe('FLEET_TEMPLATES (D.3 — 2-3 templates + custom)', () => {
  it('includes Data+Risk+Trader (showcase) and Solo Swapper', () => {
    expect(FLEET_TEMPLATES.map((t) => t.name)).toEqual(
      expect.arrayContaining(['data-risk-trader', 'solo-swapper']),
    );
  });

  it('instantiating Data+Risk+Trader creates 3 role slots with correct allowedActions', () => {
    const template = FLEET_TEMPLATES.find((t) => t.name === 'data-risk-trader')!;
    const instance = instantiateFleetTemplate(template, {
      orgCeiling: { totalBudget: 10000n, perAgentMax: 3000n, cooldownSeconds: 60, allowedDestinations: ['*'] },
    });

    expect(instance.roles).toHaveLength(3);
    expect(instance.roles.map((r) => r.role).sort()).toEqual(['data', 'risk', 'trader']);
    const trader = instance.roles.find((r) => r.role === 'trader')!;
    expect(trader.allowedActions).toContain('cspr-trade');
    const data = instance.roles.find((r) => r.role === 'data')!;
    expect(data.allowedActions).not.toContain('cspr-trade');
  });

  it('instantiating Solo Swapper creates exactly 1 trader role', () => {
    const template = FLEET_TEMPLATES.find((t) => t.name === 'solo-swapper')!;
    const instance = instantiateFleetTemplate(template, {
      orgCeiling: { totalBudget: 5000n, perAgentMax: 5000n, cooldownSeconds: 60, allowedDestinations: ['*'] },
    });

    expect(instance.roles).toHaveLength(1);
    expect(instance.roles[0]?.role).toBe('trader');
  });
});
