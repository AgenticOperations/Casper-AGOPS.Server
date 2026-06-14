import type { Redis } from 'ioredis';
import type { GatewayTransport } from './gateway.js';

/**
 * MVP stub for THE single Circle Gateway boundary (gateway.ts). Live Circle is wired at M9 — this stub
 * lets the two-phase float flow, the confirmation worker, and the demo run end-to-end WITHOUT inventing a
 * real Circle endpoint. Operations are ALWAYS final ({status:'complete'}); the natural "awaiting finality"
 * window comes from the worker's polling interval, not from a fake delay. Org available is tracked in Redis
 * (survives restart, base-unit decimal string) so GET /treasury/balances reflects deposits.
 */
const stubAvailableKey = (orgId: string): string => `stub:gateway:org:${orgId}:available`;

export function createStubTransport(redis: Redis): GatewayTransport {
  let seq = 0;
  return {
    async request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T> {
      if (req.path === '/v1/gateway/deposit') {
        const b = req.body as { orgId: string; amount: string };
        // The base-unit integer STRING is passed straight to INCRBY on purpose: Redis increments it as a
        // 64-bit integer with no JS Number rounding, so large base-unit amounts stay exact (money is never
        // a float). Do NOT Number()/parseInt() it — that would reintroduce precision loss.
        await redis.incrby(stubAvailableKey(b.orgId), b.amount);
        seq += 1;
        return { id: `stub_op_${seq}` } as T;
      }
      if (req.path.startsWith('/v1/gateway/balances/')) {
        const orgId = req.path.slice('/v1/gateway/balances/'.length);
        // Returns the wire-shape base-unit STRING, matching what a real Circle transport delivers over JSON.
        // NOTE: GatewayClient.getBalances types `available` as bigint but does NOT parse — a known gateway.ts
        // limitation. Consumers MUST BigInt() this value (getTreasuryBalances does so defensively). Returning
        // a bigint here would mask that gap before M9 wires the live transport.
        const v = (await redis.get(stubAvailableKey(orgId))) ?? '0';
        return { available: v } as T;
      }
      if (
        req.path === '/v1/gateway/deposit-for' ||
        req.path === '/v1/gateway/reclaim-for' ||
        req.path === '/v1/gateway/withdraw'
      ) {
        seq += 1;
        return { id: `stub_op_${seq}` } as T;
      }
      if (req.path.startsWith('/v1/gateway/operations/')) {
        return { status: 'complete' } as T;
      }
      throw new Error(`stub transport: unexpected path ${req.path}`);
    },
  };
}
