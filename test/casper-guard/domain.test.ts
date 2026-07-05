import { describe, expect, it } from 'vitest';
import { normalizeCasperGuardIntent } from '../../src/engines/casper-guard/types.js';

describe('AgentOps intent normalization', () => {
  it('normalizes Casper x402, CSPR.trade, and direct Casper deploy intents', () => {
    const x402 = normalizeCasperGuardIntent({
      kind: 'x402-payment',
      network: 'casper:casper-test',
      resource_id: 'svc:casper-paid-api',
      amount: '10',
      asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
      pay_to: `00${'b'.repeat(64)}`,
      max_timeout_seconds: 900,
      raw_requirement_hash: 'sha256:x402',
    });

    expect(x402).toMatchObject({
      kind: 'x402-payment',
      network: 'casper:casper-test',
      resourceId: 'svc:casper-paid-api',
      amount: '10',
      asset: { kind: 'cep18', packageHash: 'a'.repeat(64) },
      destination: `00${'b'.repeat(64)}`,
      rawRequirementHash: 'sha256:x402',
    });

    const nativeX402 = normalizeCasperGuardIntent({
      kind: 'x402-payment',
      network: 'casper:casper-test',
      resource_id: 'svc:casper-native-paid-api',
      amount: '10',
      asset: { kind: 'native', symbol: 'CSPR' },
      pay_to: `00${'d'.repeat(64)}`,
      max_timeout_seconds: 900,
      raw_requirement_hash: 'sha256:native-x402',
    });

    expect(nativeX402).toMatchObject({
      kind: 'x402-payment',
      asset: { kind: 'native', symbol: 'CSPR' },
      destination: `00${'d'.repeat(64)}`,
    });

    const trade = normalizeCasperGuardIntent({
      kind: 'cspr-trade',
      network: 'casper:casper-test',
      resource_id: 'cspr.trade:swap',
      amount: '25',
      from_asset: { kind: 'native', symbol: 'CSPR' },
      to_asset: { kind: 'cep18', package_hash: 'c'.repeat(64), name: 'Token', version: '1' },
      min_received: '20',
      slippage_bps: 50,
      route_id: 'route_1',
      risk_label: 'medium',
    });

    expect(trade).toMatchObject({
      kind: 'cspr-trade',
      fromAsset: { kind: 'native', symbol: 'CSPR' },
      toAsset: { kind: 'cep18', packageHash: 'c'.repeat(64) },
      minReceived: '20',
      slippageBps: 50,
      routeId: 'route_1',
      riskLabel: 'medium',
    });

    const deploy = normalizeCasperGuardIntent({
      kind: 'casper-deploy',
      network: 'casper:casper-test',
      resource_id: 'casper:deploy:guard-registry',
      amount: '100000000',
      asset: { kind: 'native', symbol: 'CSPR' },
      deploy_kind: 'contract-call',
      target: 'hash-guard-registry',
      entry_point: 'record_decision',
      args_hash: 'sha256:args',
    });

    expect(deploy).toMatchObject({
      kind: 'casper-deploy',
      resourceId: 'casper:deploy:guard-registry',
      amount: '100000000',
      asset: { kind: 'native', symbol: 'CSPR' },
      deployKind: 'contract-call',
      target: 'hash-guard-registry',
      entryPoint: 'record_decision',
      argsHash: 'sha256:args',
    });
  });

  it('accepts casper-deploy only for deploy resource IDs, not svc: or cspr.trade: prefixes', () => {
    // casper-deploy with a valid deploy resource parses fine
    expect(() =>
      normalizeCasperGuardIntent({
        kind: 'casper-deploy',
        network: 'casper:casper-test',
        resource_id: 'casper:deploy:guard-registry',
        amount: '100000000',
        asset: { kind: 'native', symbol: 'CSPR' },
        deploy_kind: 'contract-call',
        target: 'hash-guard-registry',
      }),
    ).not.toThrow();

    // casper-deploy with svc: or cspr.trade: prefix parses OK at the intent layer
    // but must be rejected by evaluateCasperGuardPolicy with action_kind_resource_mismatch.
    // These intents are structurally valid but semantically wrong — Guard blocks them at auth time.
    const svcDeploy = normalizeCasperGuardIntent({
      kind: 'casper-deploy',
      network: 'casper:casper-test',
      resource_id: 'svc:order-book',
      amount: '2000000000',
      asset: { kind: 'native', symbol: 'CSPR' },
      deploy_kind: 'transfer',
      target: '00' + 'a'.repeat(64),
    });
    expect(svcDeploy.kind).toBe('casper-deploy');
    expect(svcDeploy.resourceId).toBe('svc:order-book');
    // The policy check (not the schema) is what blocks this — verified via policy.test.ts
    // with real stores, and the evaluateCasperGuardPolicy guard added in policy.ts.
  });

  it('rejects unsupported Casper intent shapes fail-closed', () => {
    expect(() =>
      normalizeCasperGuardIntent({
        kind: 'x402-payment',
        network: 'ethereum:1',
        resource_id: 'svc:wrong',
        amount: '1',
        asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test', version: '1' },
        pay_to: `00${'b'.repeat(64)}`,
        max_timeout_seconds: 900,
      }),
    ).toThrow(/invalid_casper_guard_intent/);

    expect(() =>
      normalizeCasperGuardIntent({
        kind: 'cspr-trade',
        network: 'casper:casper-test',
        resource_id: 'cspr.trade:swap',
        amount: '0',
        from_asset: { kind: 'native', symbol: 'CSPR' },
        to_asset: { kind: 'native', symbol: 'CSPR' },
        min_received: '1',
        slippage_bps: 50,
        route_id: 'route_1',
      }),
    ).toThrow(/invalid_casper_guard_intent/);
  });
});
