import { describe, it, expect, vi } from 'vitest';
import { fundAgentOnChain, type AgentFundingDeps } from '../../src/engines/custody/agent-funding.js';

const AGENT = '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a';
const OPERATOR = '0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267';
const WCSPR_PKG = '3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e';

function makeDeps(overrides: Partial<AgentFundingDeps> = {}): {
  deps: AgentFundingDeps;
  tokenCalls: { entryPoint: string; args: unknown }[];
  nativeCalls: { toAccountHash: string; amountMotes: string }[];
} {
  const tokenCalls: { entryPoint: string; args: unknown }[] = [];
  const nativeCalls: { toAccountHash: string; amountMotes: string }[] = [];
  const deps: AgentFundingDeps = {
    tokenSubmitter: {
      call: vi.fn(async ({ entryPoint, args }) => {
        tokenCalls.push({ entryPoint, args });
        return { txHash: `tok-${entryPoint}` };
      }),
    },
    nativeSubmitter: {
      submitTransfer: vi.fn(async ({ toAccountHash, amountMotes }) => {
        nativeCalls.push({ toAccountHash, amountMotes });
        return { txHash: 'dust-tx' };
      }),
    },
    readWcsprBalance: vi.fn(async () => 0n),
    readOperatorWcsprBalance: vi.fn(async () => 10_000_000_000n),
    readAccountPurseExists: vi.fn(async () => true),
    wcsprPackageHash: WCSPR_PKG,
    operatorAccountHash: OPERATOR,
    dustMotes: '2500000000',
    ...overrides,
  };
  return { deps, tokenCalls, nativeCalls };
}

describe('fundAgentOnChain', () => {
  it('happy path: operator has WCSPR + purse exists → only transfer called', async () => {
    const { deps, tokenCalls, nativeCalls } = makeDeps();
    const res = await fundAgentOnChain(deps, { agentAccountHash: AGENT, amountMotes: '3000000000' });

    expect(tokenCalls.map((c) => c.entryPoint)).toEqual(['transfer']);
    expect(nativeCalls).toEqual([]);
    expect(res.transferTxHash).toBe('tok-transfer');
    expect(res.wrapTxHash).toBeUndefined();
    expect(res.dustTxHash).toBeUndefined();
  });

  it('operator WCSPR short → deposit (wrap) the shortfall first, then transfer', async () => {
    const { deps, tokenCalls } = makeDeps({
      readOperatorWcsprBalance: vi.fn(async () => 1_000_000_000n), // need 3, have 1 → wrap 2
    });
    const res = await fundAgentOnChain(deps, { agentAccountHash: AGENT, amountMotes: '3000000000' });

    expect(tokenCalls.map((c) => c.entryPoint)).toEqual(['deposit', 'transfer']);
    expect(tokenCalls[0].args).toMatchObject({ amount: { clType: 'U512', value: '2000000000' } });
    expect(res.wrapTxHash).toBe('tok-deposit');
    expect(res.transferTxHash).toBe('tok-transfer');
  });

  it('agent purse absent → native dust transfer before transfer', async () => {
    const { deps, tokenCalls, nativeCalls } = makeDeps({
      readAccountPurseExists: vi.fn(async () => false),
    });
    const res = await fundAgentOnChain(deps, { agentAccountHash: AGENT, amountMotes: '3000000000' });

    expect(nativeCalls).toEqual([{ toAccountHash: AGENT, amountMotes: '2500000000' }]);
    expect(res.dustTxHash).toBe('dust-tx');
    expect(tokenCalls.map((c) => c.entryPoint)).toEqual(['transfer']);
  });

  it('idempotent: purse exists + operator funded → dust and wrap NOT called', async () => {
    const { deps, tokenCalls, nativeCalls } = makeDeps({
      readOperatorWcsprBalance: vi.fn(async () => 10_000_000_000n),
      readAccountPurseExists: vi.fn(async () => true),
    });
    await fundAgentOnChain(deps, { agentAccountHash: AGENT, amountMotes: '3000000000' });
    expect(tokenCalls.map((c) => c.entryPoint)).toEqual(['transfer']);
    expect(nativeCalls).toEqual([]);
  });

  it('transfer throws → error propagates (caller compensates), no partial swallow', async () => {
    const { deps } = makeDeps({
      tokenSubmitter: {
        call: vi.fn(async ({ entryPoint }) => {
          if (entryPoint === 'transfer') throw new Error('transfer failed on-chain');
          return { txHash: `tok-${entryPoint}` };
        }),
      },
    });
    await expect(
      fundAgentOnChain(deps, { agentAccountHash: AGENT, amountMotes: '3000000000' }),
    ).rejects.toThrow('transfer failed on-chain');
  });
});
