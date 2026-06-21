import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { emitDecisionSafe, readRecentDecisions } from '../../src/engines/monitoring/telemetry.js';
import type { DecisionTelemetry } from '../../src/contracts/index.js';

/**
 * C-10 telemetry emit (engine-specs-FINAL.md:60,252) is the read-side COPY of an authorize decision. Two
 * hard rules: it is FAIL-OPEN — a stream-write failure NEVER fails a payment (engine-specs-FINAL.md:264);
 * and it carries decision METADATA only — no signature / X-PAYMENT bytes, so raw bytes can never reach
 * observability (BUG-31, policy-engine-FINAL.md:210). Pure unit (fake Redis) — always runs, no Docker.
 */

const base: DecisionTelemetry = {
  paymentId: 'pay_t1',
  agentId: 'agt_t1',
  orgId: 'org_t1',
  outcome: 'ALLOW',
  railScheme: 'raw-x402',
  railChain: 'arc',
  resourceId: 'svc:weather',
  amount: '5000000',
  ts: 1_800_000_000,
};

describe('C-10 telemetry emit — fail-open + redacted (engine-specs-FINAL.md:60,210,264)', () => {
  it('NEVER rejects when the stream write fails — a telemetry outage cannot fail a payment', async () => {
    const broken = { xadd: () => Promise.reject(new Error('stream down')) } as unknown as Redis;
    await expect(emitDecisionSafe(broken, base)).resolves.toBeUndefined();
  });

  it('the telemetry contract carries no signature / x_payment field (raw bytes structurally absent)', () => {
    expect(Object.keys(base)).not.toContain('signature');
    expect(Object.keys(base)).not.toContain('xPayment');
    expect(JSON.stringify(base)).not.toMatch(/signature|x_payment/i);
  });

  it('emits decision metadata to the org stream and reads it back newest-first', async () => {
    const store = new Map<string, string[]>(); // captures the XADD field array per call
    const fake = {
      xadd: (_key: string, ...args: string[]) => {
        const fields = args.slice(args.indexOf('*') + 1);
        store.set(`${store.size}-0`, fields);
        return Promise.resolve(`${store.size}-0`);
      },
      xrevrange: () =>
        Promise.resolve([...store.entries()].reverse().map(([id, f]) => [id, f] as [string, string[]])),
    } as unknown as Redis;

    await emitDecisionSafe(fake, base);
    await emitDecisionSafe(fake, {
      ...base,
      paymentId: 'pay_t2',
      outcome: 'DENY',
      reason: 'spend_cap_exceeded',
    });

    const recent = await readRecentDecisions(fake, 'org_t1', 50);
    expect(recent[0]?.paymentId).toBe('pay_t2');
    expect(recent[0]?.outcome).toBe('DENY');
    expect(recent[0]?.reason).toBe('spend_cap_exceeded');
    expect(recent[1]?.paymentId).toBe('pay_t1');
    expect(recent[1]?.outcome).toBe('ALLOW');
    expect(recent[1]?.reason).toBeUndefined();
    expect(JSON.stringify(recent)).not.toMatch(/signature|x_payment/i);
  });
});
