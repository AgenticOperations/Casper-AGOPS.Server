import { describe, it, expect, vi, beforeEach } from 'vitest';
import { teardownAgent } from '../../src/engines/provisioning/teardown.js';
import type { ProvisionDeps } from '../../src/engines/provisioning/deposit.js';
import { keys } from '../../src/redis/keyspace.js';

// Minimal Redis fake for teardown (no pending allocations, no confirmed float → sweep is the focus).
function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const sets = new Map<string, Set<string>>();
  return {
    store,
    async smembers(k: string) {
      return [...(sets.get(k) ?? [])];
    },
    async srem() {},
    async hgetall() {
      return {};
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async decrby(k: string, n: string | number) {
      const cur = BigInt(store.get(k) ?? '0') - BigInt(n);
      store.set(k, cur.toString());
      return Number(cur);
    },
    async set(k: string, v: string) {
      store.set(k, v);
    },
    defineCommand() {},
  } as never;
}

const pool = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) } as never;

describe('teardownAgent on-chain WCSPR sweep', () => {
  let redis: ReturnType<typeof makeRedis>;
  let gateway: { reclaimFor: ReturnType<typeof vi.fn> };
  let deps: ProvisionDeps;

  beforeEach(() => {
    redis = makeRedis();
    gateway = { reclaimFor: vi.fn(async () => {}) };
    deps = { pool, redis, gateway } as never;
  });

  it('sweep succeeds → teardown completes and swept amount recorded (no residual marker)', async () => {
    const sweepFn = vi.fn(async () => ({ swept: 500_000_000n, txHash: 'sweep-tx' }));
    const res = await teardownAgent(deps, {
      orgId: 'org1',
      agentId: 'agt1',
      now: 1000,
      sweep: {
        run: sweepFn,
        agentAccountHash: '00agent',
        agentPublicKeyHex: 'pk',
      },
    } as never);
    expect(res.sweptPending).toBe(0);
    expect(sweepFn).toHaveBeenCalledOnce();
    // no residual marker written
    expect(await redis.get(keys.agentSweepResidual('agt1'))).toBeNull();
  });

  it('sweep THROWS → teardown does NOT abort; records a residual marker', async () => {
    const sweepFn = vi.fn(async () => {
      throw new Error('sweep boom');
    });
    const res = await teardownAgent(deps, {
      orgId: 'org1',
      agentId: 'agt1',
      now: 1000,
      sweep: {
        run: sweepFn,
        agentAccountHash: '00agent',
        agentPublicKeyHex: 'pk',
        residualAmountHint: '500000000',
      },
    } as never);
    // teardown still returns a result (did not throw)
    expect(res).toMatchObject({ sweptPending: 0 });
    // residual marker recorded
    expect(await redis.get(keys.agentSweepResidual('agt1'))).toBe('500000000');
  });

  it('no sweep deps → teardown runs today’s path verbatim (no sweep attempted)', async () => {
    const res = await teardownAgent(deps, { orgId: 'org1', agentId: 'agt1', now: 1000 });
    expect(res).toMatchObject({ sweptPending: 0, withdrawn: 0n });
  });
});
