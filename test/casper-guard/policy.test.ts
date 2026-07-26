import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorizeCasperGuardIntent,
  resolveCasperGuardTerminalFailure,
  type CasperGuardPolicy,
  type CasperGuardSigner,
} from '../../src/engines/casper-guard/policy.js';
import {
  createCasperGuardDecision,
  markCasperGuardDecisionSigned,
  markCasperGuardDecisionTerminal,
  readCasperGuardDecision,
} from '../../src/engines/casper-guard/store.js';
import { normalizeCasperGuardIntent } from '../../src/engines/casper-guard/types.js';
import { keys } from '../../src/redis/keyspace.js';
import { seedAgent, startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

let stores: Stores | null = null;

beforeAll(async () => {
  stores = await startStores();
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

const allowPolicy: CasperGuardPolicy = {
  policyRef: 'policy_casper@v1',
  spendCap: '100',
  perTransactionMax: '100',
  serviceScope: ['svc:casper-paid-api', 'cspr.trade:swap', 'casper:deploy:guard-registry'],
  allowedActions: ['x402-payment', 'cspr-trade', 'casper-deploy'],
  allowedNetworks: ['casper:casper-test'],
  velocityLimitPerHour: 100,
  trade: { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] },
};

function signerReturning(
  signedHeaderHash: string,
  onSign?: () => void,
): CasperGuardSigner {
  return {
    kind: 'local-testnet',
    sign: () => {
      onSign?.();
      return Promise.resolve({ signedHeaderHash });
    },
  };
}

function casperX402Intent(amount = '10') {
  return normalizeCasperGuardIntent({
    kind: 'x402-payment',
    network: 'casper:casper-test',
    resource_id: 'svc:casper-paid-api',
    amount,
    asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
    pay_to: `00${'b'.repeat(64)}`,
    max_timeout_seconds: 900,
    raw_requirement_hash: 'sha256:x402-requirements',
  });
}

function nativeCasperX402Intent(amount = '10') {
  return normalizeCasperGuardIntent({
    kind: 'x402-payment',
    network: 'casper:casper-test',
    resource_id: 'svc:casper-paid-api',
    amount,
    asset: { kind: 'native', symbol: 'CSPR' },
    pay_to: `00${'b'.repeat(64)}`,
    max_timeout_seconds: 900,
    raw_requirement_hash: 'sha256:native-x402-requirements',
  });
}

function csprTradeIntent(slippageBps = 50, riskLabel = 'medium') {
  return normalizeCasperGuardIntent({
    kind: 'cspr-trade',
    network: 'casper:casper-test',
    resource_id: 'cspr.trade:swap',
    amount: '10',
    from_asset: { kind: 'native', symbol: 'CSPR' },
    to_asset: { kind: 'cep18', package_hash: 'c'.repeat(64), name: 'Token', version: '1' },
    min_received: '9',
    slippage_bps: slippageBps,
    route_id: 'route_1',
    risk_label: riskLabel,
  });
}

describe('AgentOps policy and hold lifecycle', () => {
  it('reserves the hold before signing an allowed intent', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signerObservedStatus: string | null = null;
    let signerObservedHold: string | null = null;
    const signer: CasperGuardSigner = {
      kind: 'local-testnet',
      async sign({ decisionId }) {
        const persisted = await readCasperGuardDecision(stores!.pool, decisionId);
        signerObservedStatus = persisted?.status ?? null;
        signerObservedHold = persisted?.hold?.status ?? null;
        return { signedHeaderHash: 'sha256:payment-signature' };
      },
    };

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_allow',
        holdId: 'cgh_policy_allow',
        idempotencyKey: 'idem_policy_allow',
        orgId,
        agentId,
        intent: casperX402Intent(),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );

    expect(result).toMatchObject({
      outcome: 'ALLOW',
      decisionId: 'cgd_policy_allow',
      holdId: 'cgh_policy_allow',
      signedHeaderHash: 'sha256:payment-signature',
    });
    expect(signerObservedStatus).toBe('RESERVED');
    expect(signerObservedHold).toBe('RESERVED');
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('10');

    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_policy_allow');
    expect(persisted).toMatchObject({
      status: 'SIGNED',
      signedHeaderHash: 'sha256:payment-signature',
      hold: { status: 'RESERVED', amount: '10' },
    });
  });

  it('records a deny without calling the signer or placing a hold', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:should-not-exist', () => {
      signCalls += 1;
    });

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_deny',
        holdId: 'cgh_policy_deny',
        idempotencyKey: 'idem_policy_deny',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: { ...allowPolicy, perTransactionMax: '5' },
        now: 2_000_000,
      },
    );

    expect(result).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_deny',
      reason: 'per_transaction_max_exceeded',
    });
    expect(signCalls).toBe(0);
    expect(await stores.redis.get(keys.reserved(agentId))).toBeNull();
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_policy_deny');
    expect(persisted).toMatchObject({
      status: 'DENIED',
      outcome: 'DENY',
      reasonCode: 'per_transaction_max_exceeded',
      hold: null,
    });
  });

  it('enforces service scope, velocity, kill switch, and CSPR.trade risk before signing', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:should-not-exist', () => {
      signCalls += 1;
    });

    const scopedOut = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_scope',
        holdId: 'cgh_policy_scope',
        idempotencyKey: 'idem_policy_scope',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: { ...allowPolicy, serviceScope: ['svc:other'] },
        now: 2_000_000,
      },
    );
    expect(scopedOut).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_scope',
      reason: 'service_not_allowed',
    });

    await stores.redis.set(keys.denyAll(orgId), '1');
    const killed = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_kill',
        holdId: 'cgh_policy_kill',
        idempotencyKey: 'idem_policy_kill',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    expect(killed).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_kill',
      reason: 'org_suspended',
    });
    await stores.redis.del(keys.denyAll(orgId));

    const tooFast = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_velocity',
        holdId: 'cgh_policy_velocity',
        idempotencyKey: 'idem_policy_velocity',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: { ...allowPolicy, velocityLimitPerHour: 0 },
        now: 2_000_000,
      },
    );
    expect(tooFast).toMatchObject({
      outcome: 'DENY',
      decisionId: 'cgd_policy_velocity',
      reason: 'velocity_exceeded',
    });
    // Denials carry a human-readable detail string (buildDenyDetail in policy.ts).
    expect((tooFast as { detail?: string }).detail).toContain('Velocity limit');

    const riskyTrade = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_trade',
        holdId: 'cgh_policy_trade',
        idempotencyKey: 'idem_policy_trade',
        orgId,
        agentId,
        intent: csprTradeIntent(250, 'high'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    expect(riskyTrade).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_trade',
      reason: 'trade_risk_exceeded',
    });

    expect(signCalls).toBe(0);
  });

  it('atomically enforces the spend cap under concurrent authorizations', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const signer: CasperGuardSigner = {
      kind: 'local-testnet',
      sign: () => Promise.resolve({ signedHeaderHash: `sha256:${crypto.randomUUID()}` }),
    };

    const attempts = await Promise.all([
      authorizeCasperGuardIntent(
        { pool: stores.pool, redis: stores.redis, signer },
        {
          decisionId: 'cgd_policy_race_1',
          holdId: 'cgh_policy_race_1',
          idempotencyKey: 'idem_policy_race_1',
          orgId,
          agentId,
          intent: casperX402Intent('60'),
          policy: allowPolicy,
          now: 2_000_000,
        },
      ),
      authorizeCasperGuardIntent(
        { pool: stores.pool, redis: stores.redis, signer },
        {
          decisionId: 'cgd_policy_race_2',
          holdId: 'cgh_policy_race_2',
          idempotencyKey: 'idem_policy_race_2',
          orgId,
          agentId,
          intent: casperX402Intent('60'),
          policy: allowPolicy,
          now: 2_000_000,
        },
      ),
    ]);

    expect(attempts.map((r) => r.outcome).sort()).toEqual(['ALLOW', 'DENY']);
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('60');
  });

  it('replays a completed idempotency key without placing a second hold or signing again', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:idempotent-signature', () => {
      signCalls += 1;
    });
    const base = {
      idempotencyKey: 'idem_policy_replay',
      orgId,
      agentId,
      intent: casperX402Intent('10'),
      policy: allowPolicy,
      now: 2_000_000,
    };

    const first = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      { ...base, decisionId: 'cgd_policy_replay_1', holdId: 'cgh_policy_replay_1' },
    );
    const second = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      { ...base, decisionId: 'cgd_policy_replay_2', holdId: 'cgh_policy_replay_2' },
    );

    expect(first).toEqual(second);
    expect(signCalls).toBe(1);
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('10');
  });

  it('rejects divergent idempotency-key replay instead of returning an old signature', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:original-signature', () => {
      signCalls += 1;
    });

    const first = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_idem_conflict_1',
        holdId: 'cgh_policy_idem_conflict_1',
        idempotencyKey: 'idem_policy_conflict',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    const second = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_idem_conflict_2',
        holdId: 'cgh_policy_idem_conflict_2',
        idempotencyKey: 'idem_policy_conflict',
        orgId,
        agentId,
        intent: casperX402Intent('11'),
        policy: allowPolicy,
        now: 2_000_001,
      },
    );

    expect(first).toMatchObject({ outcome: 'ALLOW', signedHeaderHash: 'sha256:original-signature' });
    expect(second).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_idem_conflict_2',
      reason: 'idempotency_conflict',
    });
    expect(signCalls).toBe(1);
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('10');
  });

  it('does not double-reserve or double-sign concurrent same-key authorizations', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer: CasperGuardSigner = {
      kind: 'local-testnet',
      async sign() {
        signCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { signedHeaderHash: 'sha256:concurrent-idempotent-signature' };
      },
    };
    const base = {
      idempotencyKey: 'idem_policy_concurrent_same_key',
      orgId,
      agentId,
      intent: casperX402Intent('60'),
      policy: allowPolicy,
      now: 2_000_000,
    };

    const attempts = await Promise.all([
      authorizeCasperGuardIntent(
        { pool: stores.pool, redis: stores.redis, signer },
        { ...base, decisionId: 'cgd_policy_same_key_1', holdId: 'cgh_policy_same_key_1' },
      ),
      authorizeCasperGuardIntent(
        { pool: stores.pool, redis: stores.redis, signer },
        { ...base, decisionId: 'cgd_policy_same_key_2', holdId: 'cgh_policy_same_key_2' },
      ),
    ]);

    expect(attempts.filter((r) => r.outcome === 'ALLOW')).toHaveLength(1);
    expect(attempts.filter((r) => r.outcome === 'DENY')).toHaveLength(1);
    expect(attempts.find((r) => r.outcome === 'DENY')).toMatchObject({
      reason: 'idempotency_in_progress',
    });
    expect(signCalls).toBe(1);
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('60');
  });

  it('classifies divergent in-flight idempotency replay as a conflict', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let releaseReserve!: () => void;
    const redis = stores.redis;
    let delayedReserve!: (...args: unknown[]) => Promise<unknown>;
    const reserveStarted = new Promise<void>((resolve) => {
      const redisCommands = redis as typeof redis & {
        reserveHoldWithinPolicy: (...args: unknown[]) => Promise<unknown>;
      };
      const originalReserve = redisCommands.reserveHoldWithinPolicy.bind(redis);
      delayedReserve = async (...args: unknown[]) => {
        resolve();
        await new Promise<void>((release) => {
          releaseReserve = release;
        });
        return originalReserve(...args);
      };
    });
    const redisWithDelayedReserve = new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop === 'reserveHoldWithinPolicy') {
          return delayedReserve;
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    let signCalls = 0;
    const signer = signerReturning('sha256:inflight-conflict-original', () => {
      signCalls += 1;
    });

    const first = authorizeCasperGuardIntent(
      { pool: stores.pool, redis: redisWithDelayedReserve, signer },
      {
        decisionId: 'cgd_policy_inflight_conflict_1',
        holdId: 'cgh_policy_inflight_conflict_1',
        idempotencyKey: 'idem_policy_inflight_conflict',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    await reserveStarted;

    const second = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_inflight_conflict_2',
        holdId: 'cgh_policy_inflight_conflict_2',
        idempotencyKey: 'idem_policy_inflight_conflict',
        orgId,
        agentId,
        intent: casperX402Intent('11'),
        policy: allowPolicy,
        now: 2_000_001,
      },
    );
    releaseReserve();
    const firstResult = await first;

    expect(second).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_inflight_conflict_2',
      reason: 'idempotency_conflict',
    });
    expect(firstResult).toMatchObject({ outcome: 'ALLOW' });
    expect(signCalls).toBe(1);
  });

  it('handles Casper base-unit amounts above Redis int64 without partial reserve corruption', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const amount = '9223372036854775808';
    // x402-payment rails enforce solvency against confirmed float (policy.ts:174), so an agent with
    // no float DENYs insufficient_float long before the big-number arithmetic under test is reached.
    // Seed float above the amount so this exercises what it claims to: reserving a value past
    // Redis's int64 range without corrupting the counter.
    await stores.redis.set(keys.floatConfirmed(agentId), (BigInt(amount) * 2n).toString());
    const signer = signerReturning('sha256:large-amount-signature');

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_large_amount',
        holdId: 'cgh_policy_large_amount',
        idempotencyKey: 'idem_policy_large_amount',
        orgId,
        agentId,
        intent: casperX402Intent(amount),
        policy: { ...allowPolicy, spendCap: `${BigInt(amount) + 1n}`, perTransactionMax: amount },
        now: 2_000_000,
      },
    );

    expect(result).toMatchObject({ outcome: 'ALLOW' });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe(amount);

    const released = await resolveCasperGuardTerminalFailure(
      { pool: stores.pool, redis: stores.redis },
      { decisionId: 'cgd_policy_large_amount', agentId, status: 'FAILED_TERMINAL' },
    );
    expect(released).toEqual({ decisionId: 'cgd_policy_large_amount', released: true });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
  });

  it('fails closed for native CSPR x402 until the x402 adapter proves native support', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:native-x402-should-not-sign', () => {
      signCalls += 1;
    });

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_native_x402',
        holdId: 'cgh_policy_native_x402',
        idempotencyKey: 'idem_policy_native_x402',
        orgId,
        agentId,
        intent: nativeCasperX402Intent('10'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );

    expect(result).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_native_x402',
      reason: 'x402_asset_not_supported',
    });
    expect(signCalls).toBe(0);
    expect(await stores.redis.get(keys.reserved(agentId))).toBeNull();
  });

  it('rechecks the kill switch after reservation and before signer invocation', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const redisWithMidflightKill = new Proxy(stores.redis, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== 'reserveHoldWithinPolicy' || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const command = (value as (...commandArgs: unknown[]) => Promise<unknown>).bind(target);
          const result = await command(...args);
          await target.set(keys.denyAll(orgId), '1');
          return result;
        };
      },
    });
    const signer = signerReturning('sha256:midflight-kill-should-not-sign', () => {
      signCalls += 1;
    });

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: redisWithMidflightKill, signer },
      {
        decisionId: 'cgd_policy_midflight_kill',
        holdId: 'cgh_policy_midflight_kill',
        idempotencyKey: 'idem_policy_midflight_kill',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );

    expect(result).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_midflight_kill',
      reason: 'org_suspended',
    });
    expect(signCalls).toBe(0);
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_policy_midflight_kill');
    expect(persisted).toMatchObject({
      status: 'FAILED_TERMINAL',
      hold: { status: 'RELEASED' },
    });
    await stores.redis.del(keys.denyAll(orgId));
  });

  it('releases the persisted hold if the kill-switch recheck itself fails', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    let existsCalls = 0;
    const redisWithFailingRecheck = new Proxy(stores.redis, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== 'exists' || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          existsCalls += 1;
          if (existsCalls === 2) throw new Error('redis_recheck_unavailable');
          const command = (value as (...commandArgs: unknown[]) => Promise<unknown>).bind(target);
          return command(...args);
        };
      },
    });
    const signer = signerReturning('sha256:recheck-error-should-not-sign', () => {
      signCalls += 1;
    });

    await expect(
      authorizeCasperGuardIntent(
        { pool: stores.pool, redis: redisWithFailingRecheck, signer },
        {
          decisionId: 'cgd_policy_recheck_error',
          holdId: 'cgh_policy_recheck_error',
          idempotencyKey: 'idem_policy_recheck_error',
          orgId,
          agentId,
          intent: casperX402Intent('10'),
          policy: allowPolicy,
          now: 2_000_000,
        },
      ),
    ).rejects.toThrow('redis_recheck_unavailable');

    expect(signCalls).toBe(0);
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_policy_recheck_error');
    expect(persisted).toMatchObject({
      status: 'FAILED_TERMINAL',
      hold: { status: 'RELEASED' },
    });
  });

  it('rejects invalid lifecycle transitions at the store boundary', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);

    await createCasperGuardDecision(stores.pool, {
      decisionId: 'cgd_policy_invalid_signed_denied',
      idempotencyKey: 'idem_policy_invalid_signed_denied',
      orgId,
      agentId,
      intent: casperX402Intent('10'),
      status: 'DENIED',
      outcome: 'DENY',
      policyRef: allowPolicy.policyRef,
      reasonCode: 'service_not_allowed',
    });
    await createCasperGuardDecision(stores.pool, {
      decisionId: 'cgd_policy_settled_final',
      idempotencyKey: 'idem_policy_settled_final',
      orgId,
      agentId,
      intent: casperX402Intent('11'),
      status: 'SETTLED',
      outcome: 'ALLOW',
      policyRef: allowPolicy.policyRef,
      signerKind: 'local-testnet',
      signedHeaderHash: 'sha256:settled-final',
    });

    await expect(
      markCasperGuardDecisionSigned(stores.pool, {
        decisionId: 'cgd_policy_invalid_signed_denied',
        signedHeaderHash: 'sha256:invalid',
      }),
    ).resolves.toBe(false);
    await expect(
      markCasperGuardDecisionTerminal(stores.pool, {
        decisionId: 'cgd_policy_settled_final',
        status: 'FAILED_TERMINAL',
      }),
    ).resolves.toBe(false);

    expect(await readCasperGuardDecision(stores.pool, 'cgd_policy_invalid_signed_denied')).toMatchObject({
      status: 'DENIED',
      signedHeaderHash: null,
    });
    expect(await readCasperGuardDecision(stores.pool, 'cgd_policy_settled_final')).toMatchObject({
      status: 'SETTLED',
    });
  });

  it('does not release a hold when the decision cannot transition to terminal failure', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const signer = signerReturning('sha256:settled-before-terminal');

    await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_settled_no_release',
        holdId: 'cgh_policy_settled_no_release',
        idempotencyKey: 'idem_policy_settled_no_release',
        orgId,
        agentId,
        intent: casperX402Intent('10'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    await stores.pool.query("UPDATE casper_guard_decisions SET status = 'SETTLED' WHERE decision_id = $1", [
      'cgd_policy_settled_no_release',
    ]);

    const result = await resolveCasperGuardTerminalFailure(
      { pool: stores.pool, redis: stores.redis },
      { decisionId: 'cgd_policy_settled_no_release', agentId, status: 'FAILED_TERMINAL' },
    );

    expect(result).toEqual({ decisionId: 'cgd_policy_settled_no_release', released: false });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('10');
    expect(await readCasperGuardDecision(stores.pool, 'cgd_policy_settled_no_release')).toMatchObject({
      status: 'SETTLED',
      hold: { status: 'RESERVED' },
    });
  });

  it('denies x402-payment when destination does not match the policy-registered payTo', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:should-not-be-reached', () => { signCalls += 1; });

    // The registeredPayTo is what the operator bound to 'svc:casper-paid-api'.
    const registeredPayTo = `00${'b'.repeat(64)}`;
    // The attackerPayTo is an out-of-scope service the agent routes to instead.
    const attackerPayTo = `00${'c'.repeat(64)}`;

    // Intent has an in-scope resource_id but a different payTo — the bypass.
    const bypassIntent = normalizeCasperGuardIntent({
      kind: 'x402-payment',
      network: 'casper:casper-test',
      resource_id: 'svc:casper-paid-api',   // in scope
      amount: '10',
      asset: { kind: 'cep18', package_hash: 'a'.repeat(64), name: 'Test CEP18', version: '1' },
      pay_to: attackerPayTo,                 // NOT the registered destination
      max_timeout_seconds: 900,
    });

    const policyWithDestinations: CasperGuardPolicy = {
      ...allowPolicy,
      serviceDestinations: { 'svc:casper-paid-api': registeredPayTo },
    };

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_dest_mismatch',
        holdId: 'cgh_dest_mismatch',
        idempotencyKey: 'idem_dest_mismatch',
        orgId,
        agentId,
        intent: bypassIntent,
        policy: policyWithDestinations,
        now: 2_000_000,
      },
    );

    expect(result).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_dest_mismatch',
      reason: 'service_scope_destination_mismatch',
    });
    expect(signCalls).toBe(0);
    expect(await stores.redis.get(keys.reserved(agentId))).toBeNull();
  });

  it('allows x402-payment when destination matches the policy-registered payTo', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const signer = signerReturning('sha256:destination-matches');

    const registeredPayTo = `00${'b'.repeat(64)}`;
    const validIntent = casperX402Intent(); // uses `00${'b'.repeat(64)}` as pay_to

    const policyWithDestinations: CasperGuardPolicy = {
      ...allowPolicy,
      serviceDestinations: { 'svc:casper-paid-api': registeredPayTo },
    };

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_dest_match',
        holdId: 'cgh_dest_match',
        idempotencyKey: 'idem_dest_match',
        orgId,
        agentId,
        intent: validIntent,
        policy: policyWithDestinations,
        now: 2_000_000,
      },
    );

    expect(result).toMatchObject({ outcome: 'ALLOW', decisionId: 'cgd_dest_match' });
  });

  it('allows x402-payment for resources not in serviceDestinations regardless of payTo', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const signer = signerReturning('sha256:unbound-resource');

    // serviceDestinations only binds 'svc:other' — 'svc:casper-paid-api' is unbound, so any payTo passes.
    const policyWithPartialDestinations: CasperGuardPolicy = {
      ...allowPolicy,
      serviceDestinations: { 'svc:other': `00${'d'.repeat(64)}` },
    };

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_unbound_resource',
        holdId: 'cgh_unbound_resource',
        idempotencyKey: 'idem_unbound_resource',
        orgId,
        agentId,
        intent: casperX402Intent(),
        policy: policyWithPartialDestinations,
        now: 2_000_000,
      },
    );

    expect(result).toMatchObject({ outcome: 'ALLOW', decisionId: 'cgd_unbound_resource' });
  });

  it('releases failed or expired holds idempotently', async ({ skip }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    const signer = signerReturning('sha256:payment-signature');

    await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_release',
        holdId: 'cgh_policy_release',
        idempotencyKey: 'idem_policy_release',
        orgId,
        agentId,
        intent: casperX402Intent('12'),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('12');

    const first = await resolveCasperGuardTerminalFailure(
      { pool: stores.pool, redis: stores.redis },
      { decisionId: 'cgd_policy_release', agentId, status: 'FAILED_TERMINAL' },
    );
    const second = await resolveCasperGuardTerminalFailure(
      { pool: stores.pool, redis: stores.redis },
      { decisionId: 'cgd_policy_release', agentId, status: 'FAILED_TERMINAL' },
    );

    expect(first).toEqual({ decisionId: 'cgd_policy_release', released: true });
    expect(second).toEqual({ decisionId: 'cgd_policy_release', released: false });
    expect(await stores.redis.get(keys.reserved(agentId))).toBe('0');
    const persisted = await readCasperGuardDecision(stores.pool, 'cgd_policy_release');
    expect(persisted).toMatchObject({
      status: 'FAILED_TERMINAL',
      hold: { status: 'RELEASED' },
    });
  });

  it('D-5②/D.2: a data-only agent (allowedActions has no cspr-trade) attempting a swap is denied action_not_allowed', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:should-not-exist', () => {
      signCalls += 1;
    });

    const dataOnlyPolicy: CasperGuardPolicy = {
      ...allowPolicy,
      allowedActions: ['x402-payment'], // no cspr-trade — matches a data/risk fleet role
    };

    const result = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer },
      {
        decisionId: 'cgd_policy_action_not_allowed',
        holdId: 'cgh_policy_action_not_allowed',
        idempotencyKey: 'idem_policy_action_not_allowed',
        orgId,
        agentId,
        intent: csprTradeIntent(),
        policy: dataOnlyPolicy,
        now: 2_000_000,
      },
    );

    expect(result).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_action_not_allowed',
      reason: 'action_not_allowed',
    });
    expect(signCalls).toBe(0);
  });

  it('D-5⑤/E.2: a swap whose min-received is worse than the live quote minus allowed slippage is denied', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const { agentId, orgId } = await seedAgent(stores.pool, stores.redis, 100);
    let signCalls = 0;
    const signer = signerReturning('sha256:should-not-exist', () => {
      signCalls += 1;
    });
    // Live quote says 10 out; allowPolicy.trade.maxSlippageBps = 100 (1%) -> floor = 9.9,
    // rounds to 9 with integer bigint math (10 * 9900 / 10000 = 9). Use a stricter case:
    // quote = 100 -> floor = 99; intent claims min_received = 90, well below the floor.
    const tradeQuoter = { quoteAmountOut: async () => 100n };

    const bad = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer, tradeQuoter },
      {
        decisionId: 'cgd_policy_quote_bad',
        holdId: 'cgh_policy_quote_bad',
        idempotencyKey: 'idem_policy_quote_bad',
        orgId,
        agentId,
        intent: normalizeCasperGuardIntent({
          kind: 'cspr-trade',
          network: 'casper:casper-test',
          resource_id: 'cspr.trade:swap',
          amount: '10',
          from_asset: { kind: 'native', symbol: 'CSPR' },
          to_asset: { kind: 'cep18', package_hash: 'c'.repeat(64), name: 'Token', version: '1' },
          min_received: '90',
          slippage_bps: 100,
          route_id: 'route_1',
          risk_label: 'medium',
        }),
        policy: allowPolicy,
        now: 2_000_000,
      },
    );
    expect(bad).toEqual({
      outcome: 'DENY',
      decisionId: 'cgd_policy_quote_bad',
      reason: 'trade_risk_exceeded',
    });
    expect(signCalls).toBe(0);

    const good = await authorizeCasperGuardIntent(
      { pool: stores.pool, redis: stores.redis, signer, tradeQuoter },
      {
        decisionId: 'cgd_policy_quote_good',
        holdId: 'cgh_policy_quote_good',
        idempotencyKey: 'idem_policy_quote_good',
        orgId,
        agentId,
        intent: normalizeCasperGuardIntent({
          kind: 'cspr-trade',
          network: 'casper:casper-test',
          resource_id: 'cspr.trade:swap',
          amount: '10',
          from_asset: { kind: 'native', symbol: 'CSPR' },
          to_asset: { kind: 'cep18', package_hash: 'c'.repeat(64), name: 'Token', version: '1' },
          min_received: '99', // at the floor (100 * 9900/10000 = 99)
          slippage_bps: 100,
          route_id: 'route_1',
          risk_label: 'medium',
        }),
        policy: allowPolicy,
        now: 2_000_001,
      },
    );
    expect(good.outcome).toBe('ALLOW');
  });
});
