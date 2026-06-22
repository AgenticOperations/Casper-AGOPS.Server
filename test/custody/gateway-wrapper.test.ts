import { describe, it, expect } from 'vitest';
import { GatewayClient, type GatewayTransport } from '../../src/lib/circle/gateway.js';
import {
  signSplTransferAuthorization,
  SolanaSeamNotImplemented,
} from '../../src/lib/solana/transfer.js';

/**
 * Claim: every Circle Gateway call routes through the single wrapper/transport (parent
 * CLAUDE.md). Solana SPL signing is a designed-for seam that throws, never a silent stub.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recordingTransport(): { transport: GatewayTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: GatewayTransport = {
    request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      calls.push({ method: req.method, path: req.path, body: req.body });
      return Promise.resolve({ id: 'op_1' } as T);
    },
  };
  return { transport, calls };
}

describe('Circle Gateway wrapper (single boundary) + Solana seam', () => {
  it('routes every operation through the injected transport with base-unit string amounts', async () => {
    const { transport, calls } = recordingTransport();
    const gw = new GatewayClient(transport);

    await gw.getBalances('org_1');
    await gw.deposit({ orgId: 'org_1', amount: 200_000_000n });
    await gw.depositFor({ orgId: 'org_1', agentId: 'agt_1', amount: 10_000_000n });
    await gw.withdraw({ orgId: 'org_1', amount: 5_000_000n });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/gateway/balances/org_1',
      'POST /v1/gateway/deposit',
      'POST /v1/gateway/deposit-for',
      'POST /v1/gateway/withdraw',
    ]);
    expect((calls[1]?.body as { amount: string }).amount).toBe('200000000'); // string, not bigint
  });

  it('Solana SPL signing throws a marked phase-2 seam error', () => {
    expect(() =>
      signSplTransferAuthorization({
        agentFloatAddress: 'Sol111',
        destination: 'Sol222',
        amount: 1_000_000n,
        validBefore: 9_999_999_999,
      }),
    ).toThrow(SolanaSeamNotImplemented);
  });
});
