import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';
import { GatewayClient } from '../../src/lib/circle/gateway.js';
import { createStubTransport } from '../../src/lib/circle/stub-transport.js';

let stores: Stores | null = null;
beforeAll(async () => { stores = await startStores(); }, 180_000);
afterAll(async () => { await stopStores(stores); });

describe('stub Circle Gateway transport (MVP, replaced by live Circle at M9)', () => {
  it('deposit credits org available; getBalances reflects it; operations are always final', async ({ skip }) => {
    if (!stores) return skip();
    const gw = new GatewayClient(createStubTransport(stores.redis));
    expect(String((await gw.getBalances('org_stub')).available)).toBe('0');
    await gw.deposit({ orgId: 'org_stub', amount: 200_000000n });
    expect(String((await gw.getBalances('org_stub')).available)).toBe('200000000');
    const op = await gw.depositFor({ orgId: 'org_stub', agentId: 'agt_a', amount: 50_000000n });
    expect(op.id).toMatch(/^stub_op_/);
    expect(await gw.isFinal(op.id)).toBe(true);
  });
});
