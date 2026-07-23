import { describe, it, expect, vi } from 'vitest';
import { createCasperTreasuryClient } from '../../src/lib/casper/treasury-client.js';

describe('createCasperTreasuryClient', () => {
  const cfg = {
    rpcUrl: 'https://node.example.invalid/rpc',
    operatorAccountHash: 'a'.repeat(64),
    pemPath: '/tmp/does-not-matter-for-this-test.pem',
    algorithm: 'ed25519' as const,
  };

  it('getBalances reads the operator account balance via Casper RPC', async () => {
    const client = createCasperTreasuryClient(cfg, {
      queryBalance: async () => ({ ok: true, motes: 500_000_000_000n }),
      submitTransfer: async () => ({ txHash: 'tx1' }),
      isTransferFinal: async () => true,
    });
    const balances = await client.getBalances('org_1');
    expect(balances).toEqual({ available: 500_000_000_000n });
  });

  it('getBalances returns 0 when the RPC read fails (honest-blocked, never throws)', async () => {
    const client = createCasperTreasuryClient(cfg, {
      queryBalance: async () => ({ ok: false, reason: 'rpc_error' }),
      submitTransfer: async () => ({ txHash: 'tx1' }),
      isTransferFinal: async () => true,
    });
    const balances = await client.getBalances('org_1');
    expect(balances).toEqual({ available: 0n });
  });

  it('depositFor submits a native transfer to the given agentFloatAddress and returns its tx hash as the op id', async () => {
    const submitTransfer = vi.fn().mockResolvedValue({ txHash: 'tx-deposit-1' });
    const client = createCasperTreasuryClient(cfg, {
      queryBalance: async () => ({ ok: true, motes: 0n }),
      submitTransfer,
      isTransferFinal: async () => true,
    });
    const result = await client.depositFor({
      orgId: 'org_1',
      agentId: 'agt_1',
      amount: 1_000_000_000n,
      agentFloatAddress: 'bb'.repeat(32),
    });
    expect(result).toEqual({ id: 'tx-deposit-1' });
    expect(submitTransfer).toHaveBeenCalledWith({ toAccountHash: 'bb'.repeat(32), amountMotes: '1000000000' });
  });

  it('isFinal reports the transfer finality seam result', async () => {
    const client = createCasperTreasuryClient(cfg, {
      queryBalance: async () => ({ ok: true, motes: 0n }),
      submitTransfer: async () => ({ txHash: 'tx1' }),
      isTransferFinal: async () => true,
    });
    expect(await client.isFinal('tx1')).toBe(true);
  });

  it('reclaimFor submits a transfer back to the operator account', async () => {
    const submitTransfer = vi.fn().mockResolvedValue({ txHash: 'tx-reclaim-1' });
    const client = createCasperTreasuryClient(cfg, {
      queryBalance: async () => ({ ok: true, motes: 0n }),
      submitTransfer,
      isTransferFinal: async () => true,
    });
    await client.reclaimFor({ orgId: 'org_1', agentId: 'agt_1', amount: 2_000_000_000n });
    expect(submitTransfer).toHaveBeenCalledWith({
      toAccountHash: cfg.operatorAccountHash,
      amountMotes: '2000000000',
    });
  });

  it('deposit (org-level) submits a transfer and returns its id', async () => {
    const submitTransfer = vi.fn().mockResolvedValue({ txHash: 'tx-org-deposit' });
    const client = createCasperTreasuryClient(cfg, {
      queryBalance: async () => ({ ok: true, motes: 0n }),
      submitTransfer,
      isTransferFinal: async () => true,
    });
    const result = await client.deposit({ orgId: 'org_1', amount: 3_000_000_000n });
    expect(result).toEqual({ id: 'tx-org-deposit' });
  });
});
