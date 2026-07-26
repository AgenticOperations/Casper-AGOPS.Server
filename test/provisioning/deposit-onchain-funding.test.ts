import { describe, it, expect, vi, beforeEach } from 'vitest';
import { depositFor, type ProvisionDeps, type DepositForParams } from '../../src/engines/provisioning/deposit.js';
import type { AgentFundingDeps } from '../../src/engines/custody/agent-funding.js';
import { keys } from '../../src/redis/keyspace.js';

// In-memory Redis fake supporting the ops depositFor uses.
function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    hashes,
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
    },
    async incrby(k: string, n: string | number) {
      const cur = BigInt(store.get(k) ?? '0') + BigInt(n);
      store.set(k, cur.toString());
      return Number(cur);
    },
    async decrby(k: string, n: string | number) {
      const cur = BigInt(store.get(k) ?? '0') - BigInt(n);
      store.set(k, cur.toString());
      return Number(cur);
    },
    async hset(k: string, obj: Record<string, string>) {
      hashes.set(k, { ...(hashes.get(k) ?? {}), ...obj });
    },
    async sadd(k: string, m: string) {
      const s = sets.get(k) ?? new Set();
      s.add(m);
      sets.set(k, s);
    },
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    },
    // no-op: allocation-eval calls defineCommand then reserveAllocation; we implement the latter directly.
    defineCommand() {},
    // Mirror allocation-reserve.lua: available = total - committed - reserved; INCR reserved on pass.
    async reserveAllocation(committedKey: string, reservedKey: string, total: string, requested: string) {
      const committed = BigInt(store.get(committedKey) ?? '0');
      const reserved = BigInt(store.get(reservedKey) ?? '0');
      const available = BigInt(total) - committed - reserved;
      if (BigInt(requested) > available) return 0;
      store.set(reservedKey, (reserved + BigInt(requested)).toString());
      return 1;
    },
  } as never;
}

const POLICY = {
  perAgentMax: 1_000_000_000_000n,
  totalBudget: 1_000_000_000_000n,
  allowedDestinations: ['00op'],
  cooldownSeconds: 0,
  maxSiblingsPerWindow: 1000,
} as never;

function baseParams(over: Partial<DepositForParams> = {}): DepositForParams {
  return {
    orgId: 'org1',
    agentId: 'agt1',
    agentFloatAddress: '00op',
    amount: 3_000_000_000n,
    policy: POLICY,
    // This suite drives a stubbed reserve to isolate the on-chain funding orchestration; solvency is
    // covered by allocation-budget.test.ts. Funded high so it never becomes the reason for a DENY.
    fundedTotal: 1_000_000_000_000n,
    kind: 'depositFor',
    secondsSinceLastAllocation: null,
    now: 1000,
    ...over,
  };
}

function makeFunding(): { funding: AgentFundingDeps; fundSpy: ReturnType<typeof vi.fn> } {
  const fundSpy = vi.fn(async () => ({ transferTxHash: 'ttx', wrapTxHash: 'wtx', dustTxHash: 'dtx' }));
  const funding = {
    tokenSubmitter: { call: vi.fn() },
    nativeSubmitter: { submitTransfer: vi.fn() },
    readWcsprBalance: vi.fn(),
    readOperatorWcsprBalance: vi.fn(),
    readAccountPurseExists: vi.fn(),
    wcsprPackageHash: 'pkg',
    operatorAccountHash: '00op',
    dustMotes: '2500000000',
  } as unknown as AgentFundingDeps;
  return { funding, fundSpy };
}

describe('depositFor on-chain funding', () => {
  let gatewaySpy: ReturnType<typeof vi.fn>;
  let deps: ProvisionDeps;
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    gatewaySpy = vi.fn(async () => ({ id: 'txref-native' }));
    redis = makeRedis();
    deps = { pool: {} as never, redis, gateway: { depositFor: gatewaySpy } as never };
  });

  it('reserve DENY → funding NOT called (ceiling gate precedes funding)', async () => {
    const { funding, fundSpy } = makeFunding();
    // over per-agent max forces DENY
    const res = await depositFor(deps, baseParams({
      amount: 2_000_000_000_000n,
      agentAccountHash: '00agent',
      funding,
      fundAgentOnChain: fundSpy,
    } as never));
    expect(res.outcome).toBe('DENY');
    expect(fundSpy).not.toHaveBeenCalled();
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  it('reserve ALLOW + funding succeeds → SUBMITTED, float_pending incremented, tx hashes recorded', async () => {
    const { funding, fundSpy } = makeFunding();
    const res = await depositFor(deps, baseParams({
      agentAccountHash: '00agent',
      funding,
      fundAgentOnChain: fundSpy,
    } as never));
    expect(res.outcome).toBe('SUBMITTED');
    expect(fundSpy).toHaveBeenCalledWith(funding, { agentAccountHash: '00agent', amountMotes: '3000000000' });
    expect(await redis.get(keys.floatPending('agt1'))).toBe('3000000000');
    // funding tx hashes stored on the allocation hash
    const allocKey = [...redis.hashes.keys()].find((k) => k.includes('alloc'));
    expect(redis.hashes.get(allocKey!)).toMatchObject({ fundTxHash: 'ttx', wrapTxHash: 'wtx', dustTxHash: 'dtx' });
  });

  it('reserve ALLOW + funding THROWS → reserve compensated, float_pending NOT incremented, FUNDING_FAILED', async () => {
    const fundSpy = vi.fn(async () => {
      throw new Error('on-chain boom');
    });
    const { funding } = makeFunding();
    const res = await depositFor(deps, baseParams({
      agentAccountHash: '00agent',
      funding,
      fundAgentOnChain: fundSpy,
    } as never));
    expect(res.outcome).toBe('FUNDING_FAILED');
    // reserve was compensated back to 0
    expect(await redis.get(keys.allocationReserved('org1'))).toBe('0');
    // float_pending never incremented
    expect(await redis.get(keys.floatPending('agt1'))).toBeNull();
  });

  it('no agentAccountHash/funding → funding skipped, current behavior preserved', async () => {
    const res = await depositFor(deps, baseParams());
    expect(res.outcome).toBe('SUBMITTED');
    expect(gatewaySpy).toHaveBeenCalledOnce();
    expect(await redis.get(keys.floatPending('agt1'))).toBe('3000000000');
  });
});
