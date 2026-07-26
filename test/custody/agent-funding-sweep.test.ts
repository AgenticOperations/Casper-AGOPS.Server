import { describe, it, expect, vi } from 'vitest';
import { sweepAgentWcsprOnChain, type SweepDeps } from '../../src/engines/custody/agent-funding-sweep.js';

const AGENT_OWN = '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a';
const OPERATOR = '0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267';

function makeDeps(over: Partial<SweepDeps> = {}): {
  deps: SweepDeps;
  tokenCall: ReturnType<typeof vi.fn>;
  buildAuth: ReturnType<typeof vi.fn>;
} {
  const tokenCall = vi.fn(async () => ({ txHash: 'sweep-tx' }));
  const buildAuth = vi.fn(async () => ({
    authorization: {},
    signatureHex: '01',
    publicKeyHex: 'pk',
    args: { from: {}, to: {}, amount: {}, valid_after: {}, valid_before: {}, nonce: {}, public_key: {}, signature: {} },
  }));
  const deps: SweepDeps = {
    tokenSubmitter: { call: tokenCall },
    readWcsprBalance: vi.fn(async () => 500_000_000n),
    buildAuthorization: buildAuth as never,
    vault: {} as never,
    wcsprPackageHash: 'pkg',
    operatorAccountHash: OPERATOR,
    domainName: 'Wrapped CSPR',
    domainVersion: '1',
    chainName: 'casper-test',
    maxTimeoutSeconds: 300,
    ...over,
  };
  return { deps, tokenCall, buildAuth };
}

describe('sweepAgentWcsprOnChain', () => {
  it('agent has WCSPR → builds vault-signed authorization agent→operator and operator submits transfer_with_authorization', async () => {
    const { deps, tokenCall, buildAuth } = makeDeps();
    const res = await sweepAgentWcsprOnChain(deps, {
      agentId: 'agt1',
      agentAccountHash: AGENT_OWN,
      agentPublicKeyHex: 'pk-agent',
    });
    expect(res.swept).toBe(500_000_000n);
    expect(res.txHash).toBe('sweep-tx');
    // authorization directed agent→operator for the full balance
    expect(buildAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountHash: AGENT_OWN,
        toAccountHash: OPERATOR,
        amountMotes: '500000000',
        agentId: 'agt1',
        publicKeyHex: 'pk-agent',
      }),
    );
    // operator submits the transfer_with_authorization entry point
    expect(tokenCall).toHaveBeenCalledWith(
      expect.objectContaining({ packageHash: 'pkg', entryPoint: 'transfer_with_authorization' }),
    );
  });

  it('agent has zero WCSPR → no-op (no tx, no vault/auth call)', async () => {
    const { deps, tokenCall, buildAuth } = makeDeps({ readWcsprBalance: vi.fn(async () => 0n) });
    const res = await sweepAgentWcsprOnChain(deps, {
      agentId: 'agt1',
      agentAccountHash: AGENT_OWN,
      agentPublicKeyHex: 'pk-agent',
    });
    expect(res.swept).toBe(0n);
    expect(res.txHash).toBeUndefined();
    expect(buildAuth).not.toHaveBeenCalled();
    expect(tokenCall).not.toHaveBeenCalled();
  });
});
