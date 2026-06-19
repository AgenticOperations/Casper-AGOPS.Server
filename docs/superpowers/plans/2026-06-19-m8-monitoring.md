# M8 — Monitoring (E8, thin) + kill-switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development per chunk (red → green → refactor). Steps use checkbox (`- [ ]`) syntax. Locked loop: red → impl → green → full suite + typecheck + lint + build → mark checkbox → append `log-server`.

**Goal:** Wire Engine 8 (Monitoring) as a thin, read-side observability + control surface: a fail-open C-10 telemetry copy of every authorize decision, a dashboard/SSE feed over it, and the P1-actuated graded brakes (Tier-3 org `DENY_ALL` kill-switch + Tier-2 per-agent suspend) — then use the suspend actuator to close the M6 teardown reclaim-fence (SPIKE-03).

**Architecture:** Monitoring is the Datadog analog: **read-side, NEVER on the hot path** (engine-specs-FINAL.md:249), **depended on by nothing** (:327), **fail-open for visibility** — a Monitoring outage must never stop payments, and the inverse wiring is forbidden (:264). The kill-switch READ gates already exist (enforce.ts:113 P3-A, allocation-eval.ts:64 P3-B; auth.ts:56 agent suspend); M8 builds only the missing **emit / set / clear / surface** halves. The telemetry emit is a fire-and-forget *copy* at the **oracle boundary** (not woven into the enforcement core), and it **redacts** signature + X-PAYMENT bytes (BUG-31, policy-engine-FINAL.md:210). Graded response is request/actuate-split (BUG-15, engine-specs-FINAL.md:256): the operator's `sk_live_` admin key (P1 authority) actuates Tier-2/Tier-3; Monitoring surfaces + requests.

**Tech Stack:** Node 20 + TS strict (NodeNext ESM, `.js` imports, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Fastify, ioredis (Redis Streams: `XADD MAXLEN ~` / `XREVRANGE` / `XREAD BLOCK`), pg, Vitest + Testcontainers (postgres:16-alpine, redis:7-alpine), ESLint-9 flat (no-console).

---

## Why this thin cut (distilled from the FINAL specs, no fork)

| Spec capability (engine-specs-FINAL.md) | M8 ships | Deferred (cited) |
|---|---|---|
| Telemetry collector — C-10 structured events (:252) | ALLOW/DENY/DUPLICATE **decision** copy → `authorizeStream`, redacted, fail-open | state-transition / sign / settlement / allocation / reputation-post event types → emit at their planes later (additive, same sink) |
| Dashboard surface (:258) | `GET /v1/monitoring/decisions` JSON feed + SSE tail | per-Org/Team/Agent aggregation UI = M9 / frontend |
| Burn-rate + budget monitor (:254) | — | burn-rate/velocity analytics + alerting pipeline + dead-man's-switch (:268) = dashboard enrichment, M9/frontend |
| Graded response C-12 (:256) — Tier 2 suspend, Tier 3 DENY_ALL | **Tier 2** per-agent suspend + **Tier 3** org `DENY_ALL` set/clear actuators | **Tier 1** `anomaly_flag` advisory speed-bump (needs a P3-A advisory read namespace — scope creep beyond "kill-switch"); **Tier 4** emergency treasury lock (2-of-3 multisig — out of Phase-1) |
| Kill-switch actuator, P1-owned (:80) | Redis set/clear of `denyAll`, NO TTL (fail-closed); pg agent-status flip | MFA on Tier-3 actuation (:256) = auth hardening, M9 |
| Teardown reclaim-fence (teardown.ts:24, SPIKE-03) | suspend agent BEFORE sweep+reclaim so a concurrent spend can't race | the mempool-cancel-vs-await finality safety decision stays SPIKE-03 |

**No-fork mapping.** The spec locks: Monitoring is read-side / off the hot path / fail-open (:249,264,327); C-10 is an *async copy* of telemetry (:60); signature bytes are boundaried out of observability (:210, BUG-31); the kill-switch is a single P1-owned Redis overwrite primitive, scoped, fail-safe (:80), with `DENY_ALL` freezing P3-A **and** P3-B and carrying **no TTL** (:128,256). M8 introduces **no new architectural claim** — it wires the write/control/surface halves of gates that already exist read-side.

**Decouple discipline (carried from M7).** Just as reputation must not appear in the authorize spine, the **money-decision core** (P2 Resolution quote-assembly + P3 Enforcement decide/sign) must import **no** monitoring module — so Monitoring can never sit in the decision. The **oracle (E9)** is the legitimate emit boundary (the spec's "all planes → Monitoring" copy edge, :60); its emit is fail-open (`emitDecisionSafe` never rejects), so it cannot block spend. The structural guard therefore scans `enforcement` + `resolution` (not `oracle`).

---

## File structure

```
src/contracts/index.ts                       ← MODIFY: add C-10 DecisionTelemetry
src/engines/monitoring/telemetry.ts          ← NEW (L1): emit (fail-open, redacted) + read API
src/engines/oracle/authorize.ts              ← MODIFY (L1): fire-and-forget emit at the decision boundary
src/engines/control/kill-switch.ts           ← NEW (L2): Tier-3 denyAll + Tier-2 agent-status actuators (P1)
src/engines/control/admin-auth.ts            ← NEW (L3): resolve sk_live_ bearer → orgId (operator/P1 auth)
src/engines/monitoring/routes.ts             ← NEW (L3): dashboard feed + SSE + admin control routes
src/app.ts                                    ← MODIFY (L3): register monitoring routes
src/engines/provisioning/teardown.ts         ← MODIFY (L4): suspend-agent fence before sweep+reclaim

test/monitoring/telemetry-redaction.test.ts   ← NEW (L1): shape carries no sig; emit fail-open; stream copy
test/monitoring/kill-switch-actuates.test.ts  ← NEW (L2): set/clear flips a real authorize ALLOW↔DENY; suspend
test/monitoring/routes.test.ts                ← NEW (L3): feed read-only + admin-authed; SSE; structural guard
test/invariant/monitoring-decoupled.test.ts   ← NEW (L3): money core imports no monitoring (structural)
test/provisioning/teardown-fence.test.ts      ← NEW (L4): suspend ordered before reclaim; fence persists
```

---

## Task L1 — C-10 telemetry: emit (fail-open, redacted) + read API — ✅ DONE (green: 48 files/148+2)

**Files:**
- Modify: `src/contracts/index.ts` (add `DecisionTelemetry` near the other C-* contracts)
- Create: `src/engines/monitoring/telemetry.ts`
- Modify: `src/engines/oracle/authorize.ts:111-126` (emit at the decision boundary)
- Test: `test/monitoring/telemetry-redaction.test.ts`

- [ ] **Step 1 — Add the C-10 contract.** In `src/contracts/index.ts`, add (the *redacted* decision copy; NO `signature` / `xPayment` field exists, so raw bytes are structurally impossible):

```ts
/**
 * C-10 (engine-specs-FINAL.md:60,252) — the read-side telemetry COPY of one authorize decision,
 * consumed by Monitoring (E8). It carries decision METADATA only: by construction there is no
 * signature or X-PAYMENT field, so raw signature bytes can never reach observability (BUG-31,
 * policy-engine-FINAL.md:210). `amount` is a base-units string (never float, never a wire bigint).
 */
export interface DecisionTelemetry {
  paymentId: string;
  agentId: AgentId;
  orgId: OrgId;
  outcome: 'ALLOW' | 'DENY' | 'DUPLICATE';
  reason?: DenyReason;
  railScheme: string;
  railChain: string;
  resourceId: string;
  amount: string;
  ts: number;
}
```

- [ ] **Step 2 — Write the failing test** `test/monitoring/telemetry-redaction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { emitDecisionSafe, readRecentDecisions } from '../../src/engines/monitoring/telemetry.js';
import type { DecisionTelemetry } from '../../src/contracts/index.js';

const base: DecisionTelemetry = {
  paymentId: 'pay_t1', agentId: 'agt_t1', orgId: 'org_t1', outcome: 'ALLOW',
  railScheme: 'raw-x402', railChain: 'arc', resourceId: 'svc:weather', amount: '5000000', ts: 1_800_000_000,
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
      xadd: (_key: string, ..._args: string[]) => {
        const fields = _args.slice(_args.indexOf('*') + 1);
        store.set(`id-${store.size}`, fields);
        return Promise.resolve(`${store.size}-0`);
      },
      xrevrange: (_key: string, _hi: string, _lo: string, _c: string, _n: number) =>
        Promise.resolve([...store.entries()].reverse().map(([id, f]) => [id, f] as [string, string[]])),
    } as unknown as Redis;
    await emitDecisionSafe(fake, base);
    await emitDecisionSafe(fake, { ...base, paymentId: 'pay_t2', outcome: 'DENY', reason: 'spend_cap_exceeded' });
    const recent = await readRecentDecisions(fake, 'org_t1', 50);
    expect(recent[0]?.paymentId).toBe('pay_t2');
    expect(recent[0]?.outcome).toBe('DENY');
    expect(recent[0]?.reason).toBe('spend_cap_exceeded');
    expect(recent[1]?.paymentId).toBe('pay_t1');
    expect(JSON.stringify(recent)).not.toMatch(/signature|x_payment/i);
  });
});
```

- [ ] **Step 3 — Run it, verify RED.** `cd .../BUILD/Backend && npx vitest run test/monitoring/telemetry-redaction.test.ts` → FAIL (`telemetry.js` missing).

- [ ] **Step 4 — Implement** `src/engines/monitoring/telemetry.ts`:

```ts
import type { Redis } from 'ioredis';
import { keys } from '../../redis/keyspace.js';
import type { DecisionTelemetry } from '../../contracts/index.js';

/**
 * E8 telemetry sink (engine-specs-FINAL.md:247-264). Monitoring is READ-SIDE and holds no authoritative
 * state (:262) — this stream is a rebuildable COPY (C-10 "async, copy", :60). The authoritative record is
 * the P4 payment_events audit row (events.ts). Two hard rules: (1) it carries decision metadata only —
 * no signature / X-PAYMENT bytes ever (BUG-31, policy-engine-FINAL.md:210); (2) it is FAIL-OPEN — a write
 * failure NEVER propagates to the caller, so a telemetry/Monitoring outage can never fail a payment (:264).
 */

// Approximate cap: Monitoring holds no authoritative state and is rebuildable (:262), so the live tail is
// bounded; `~` lets Redis trim at radix-tree-node boundaries (cheap). Older history lives in P4 (pg).
const STREAM_MAXLEN = 1000;

export interface DecisionEntry extends DecisionTelemetry {
  /** Redis stream entry id. */
  id: string;
}

export async function emitDecisionSafe(redis: Redis, t: DecisionTelemetry): Promise<void> {
  try {
    const fields: string[] = ['payment_id', t.paymentId, 'agent_id', t.agentId, 'outcome', t.outcome];
    if (t.reason) fields.push('reason', t.reason);
    fields.push(
      'rail_scheme', t.railScheme, 'rail_chain', t.railChain,
      'resource_id', t.resourceId, 'amount', t.amount, 'ts', String(t.ts),
    );
    await redis.xadd(keys.authorizeStream(t.orgId), 'MAXLEN', '~', STREAM_MAXLEN, '*', ...fields);
  } catch {
    // Fail-open (engine-specs-FINAL.md:264). Visibility degrades; the payment is unaffected.
  }
}

function entryFrom(id: string, orgId: string, fields: string[]): DecisionEntry {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) m.set(fields[i] as string, fields[i + 1] as string);
  const outcome = (m.get('outcome') ?? 'DENY') as DecisionTelemetry['outcome'];
  const reason = m.get('reason');
  return {
    id,
    paymentId: m.get('payment_id') ?? '',
    agentId: m.get('agent_id') ?? '',
    orgId,
    outcome,
    ...(reason ? { reason: reason as DecisionEntry['reason'] } : {}),
    railScheme: m.get('rail_scheme') ?? '',
    railChain: m.get('rail_chain') ?? '',
    resourceId: m.get('resource_id') ?? '',
    amount: m.get('amount') ?? '0',
    ts: Number(m.get('ts') ?? '0'),
  };
}

export async function readRecentDecisions(
  redis: Redis,
  orgId: string,
  limit = 50,
): Promise<DecisionEntry[]> {
  const raw = (await redis.xrevrange(keys.authorizeStream(orgId), '+', '-', 'COUNT', limit)) as Array<
    [string, string[]]
  >;
  return raw.map(([id, fields]) => entryFrom(id, orgId, fields));
}
```

- [ ] **Step 5 — Run it, verify GREEN.** `npx vitest run test/monitoring/telemetry-redaction.test.ts` → PASS (3/3).

- [ ] **Step 6 — Wire the emit at the oracle boundary.** In `src/engines/oracle/authorize.ts`, add the import and emit a fire-and-forget copy in each outcome branch. `quote`, `auth.agent`, `paymentId`, `now` are all in scope:

```ts
import { emitDecisionSafe } from '../monitoring/telemetry.js';
```

Replace the `switch (result.outcome)` block (currently lines ~111-126) with a version that emits before mapping to HTTP (build a `base` once from the resolved quote + authed identity):

```ts
    // 7. Emit a fail-open C-10 telemetry COPY (redacted; never blocks spend), then map outcome → HTTP.
    const base = {
      agentId: auth.agent.agentId,
      orgId: auth.agent.orgId,
      railScheme: quote.rail.scheme,
      railChain: quote.rail.chain,
      resourceId: quote.resourceId,
      amount: quote.amount.toString(),
      ts: now,
    };
    switch (result.outcome) {
      case 'ALLOW':
        await emitDecisionSafe(redis, { ...base, paymentId: result.paymentId, outcome: 'ALLOW' });
        request.log.info(
          { decision: { payment_id: result.paymentId, outcome: 'ALLOW', x_payment: result.xPayment } },
          'authorize.decision',
        );
        return reply.code(200).send({ payment_id: result.paymentId, x_payment: result.xPayment });
      case 'DENY':
        await emitDecisionSafe(redis, { ...base, paymentId, outcome: 'DENY', reason: result.reason });
        request.log.info(
          { decision: { payment_id: paymentId, outcome: 'DENY', reason: result.reason } },
          'authorize.decision',
        );
        return reply.code(403).send({ error: result.reason });
      case 'DUPLICATE':
        await emitDecisionSafe(redis, { ...base, paymentId: result.paymentId, outcome: 'DUPLICATE' });
        return reply.code(409).send({ payment_id: result.paymentId, error: 'duplicate' });
    }
```

(`redis` is already destructured from `app.deps` at the top of the handler.) `emitDecisionSafe` never rejects, so awaiting it is safe and keeps the stream write deterministic for tests; even with Redis down it returns fast (caught) and the decision is returned regardless.

- [ ] **Step 7 — Full gate.** `npx vitest run` (all) + `npx tsc --noEmit` + `npx eslint .` + `npm run build`. Existing `no-raw-sig-bytes` still green (the log redaction path is untouched). Mark this checkbox + append `log-server` (`M8.L1 · …`).

---

## Task L2 — kill-switch + suspend control surface (Tier 3 + Tier 2 actuators) — ✅ DONE (green: 49 files/150+2)

**Files:**
- Create: `src/engines/control/kill-switch.ts`
- Test: `test/monitoring/kill-switch-actuates.test.ts` (Testcontainers — drives a real authorize)

- [ ] **Step 1 — Write the failing test** `test/monitoring/kill-switch-actuates.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  setOrgKillSwitch, clearOrgKillSwitch, isOrgSuspended, suspendAgent, reinstateAgent,
} from '../../src/engines/control/kill-switch.js';
import {
  startStores, stopStores, buildOracleApp, seedAgent, raw402, requestContext, type Stores,
} from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => { stores = await startStores(); if (stores) app = buildOracleApp(stores.pool, stores.redis); }, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

const authorize = (apiKey: string, agentId: string) =>
  app!.inject({
    method: 'POST', url: '/v1/payment/authorize',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
  });

describe('Tier-3 org kill-switch actuator drives the EXISTING gate (engine-specs-FINAL.md:80,128,256)', () => {
  it('set → a previously-ALLOWED spend DENYs org_suspended; clear → ALLOW again', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    expect((await authorize(apiKey, agentId)).statusCode).toBe(200); // baseline ALLOW

    await setOrgKillSwitch(stores.redis, orgId);
    expect(await isOrgSuspended(stores.redis, orgId)).toBe(true);
    const denied = await authorize(apiKey, agentId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('org_suspended');

    await clearOrgKillSwitch(stores.redis, orgId);
    expect(await isOrgSuspended(stores.redis, orgId)).toBe(false);
    expect((await authorize(apiKey, agentId)).statusCode).toBe(200); // restored
  });
});

describe('Tier-2 per-agent suspend actuator (engine-specs-FINAL.md:256; auth.ts gate)', () => {
  it('suspend → 403 agent_suspended; reinstate → ALLOW; tenant-fenced + idempotent unknown=false', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    expect(await suspendAgent(stores.pool, { agentId, orgId })).toBe(true);
    const denied = await authorize(apiKey, agentId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('agent_suspended');

    expect(await reinstateAgent(stores.pool, { agentId, orgId })).toBe(true);
    expect((await authorize(apiKey, agentId)).statusCode).toBe(200);

    // cross-tenant / unknown id changes nothing (tenant isolation, :268).
    expect(await suspendAgent(stores.pool, { agentId, orgId: 'org_other' })).toBe(false);
    expect(await suspendAgent(stores.pool, { agentId: 'agt_nope', orgId })).toBe(false);
  });
});
```

- [ ] **Step 2 — Run it, verify RED.** `npx vitest run test/monitoring/kill-switch-actuates.test.ts` → FAIL (`kill-switch.js` missing). (Skips cleanly if no Docker.)

- [ ] **Step 3 — Implement** `src/engines/control/kill-switch.ts`:

```ts
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { keys } from '../../redis/keyspace.js';

/**
 * P1-owned graded-response actuators (engine-specs-FINAL.md:80,256, BUG-15). Monitoring REQUESTS; P1
 * (the operator's sk_live_ admin authority) ACTUATES. The READ gates already exist — enforce.ts:113
 * (P3-A) and allocation-eval.ts:64 (P3-B) test `denyAll`; auth.ts:56 refuses a suspended agent. This
 * module is only the set/clear half.
 */

// Tier 3 — org DENY_ALL. Single Redis overwrite primitive (:80). NO TTL: fail-closed, lifted only by an
// explicit clear (:256). Freezes P3-A AND P3-B (:128). Presence is the whole signal (value is a marker).
export async function setOrgKillSwitch(redis: Redis, orgId: string): Promise<void> {
  await redis.set(keys.denyAll(orgId), '1');
}
export async function clearOrgKillSwitch(redis: Redis, orgId: string): Promise<void> {
  await redis.del(keys.denyAll(orgId));
}
export async function isOrgSuspended(redis: Redis, orgId: string): Promise<boolean> {
  return (await redis.exists(keys.denyAll(orgId))) === 1;
}

// Tier 2 — per-agent suspend. Tenant-fenced (org isolation, :268): the UPDATE matches on (id, org_id),
// so an operator can only act within their own org and an unknown id is a no-op. Returns whether a row
// changed (idempotent: re-suspending an already-suspended agent still returns true on the matched row).
export async function suspendAgent(pool: pg.Pool, p: { agentId: string; orgId: string }): Promise<boolean> {
  const res = await pool.query(`UPDATE agents SET status = 'suspended' WHERE id = $1 AND org_id = $2`, [
    p.agentId, p.orgId,
  ]);
  return (res.rowCount ?? 0) > 0;
}
export async function reinstateAgent(pool: pg.Pool, p: { agentId: string; orgId: string }): Promise<boolean> {
  const res = await pool.query(`UPDATE agents SET status = 'active' WHERE id = $1 AND org_id = $2`, [
    p.agentId, p.orgId,
  ]);
  return (res.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4 — Run it, verify GREEN.** `npx vitest run test/monitoring/kill-switch-actuates.test.ts` → PASS (2/2).

- [ ] **Step 5 — Full gate** (all + tsc + eslint + build). Mark checkbox + append `log-server` (`M8.L2 · …`).

---

## Task L3 — monitoring HTTP surface + observe-only structural guard — ✅ DONE (green: 51 files/155+2)

**Files:**
- Create: `src/engines/control/admin-auth.ts`
- Create: `src/engines/monitoring/routes.ts`
- Modify: `src/app.ts` (register the routes)
- Modify: `test/helpers/oracle-harness.ts` (`seedAgent` also returns the org `adminKey` token — additive; no existing caller breaks)
- Test: `test/monitoring/routes.test.ts` (Testcontainers) + `test/invariant/monitoring-decoupled.test.ts` (pure)

- [ ] **Step 0 — Expose the admin token from the harness (additive).** In `test/helpers/oracle-harness.ts`, `seedAgent` currently discards the org admin token (`adminKeyHash: issueAdminKey().hash`). Capture and return it so a test can drive the admin surface for the same org as the seeded agent:

```ts
  const adminKey = issueAdminKey();
  const org = await createOrg(pool, { name: 'Acme', adminKeyHash: adminKey.hash });
  // … unchanged …
  return { orgId: org.id, agentId: agent.id, apiKey: apiKey.token, adminKey: adminKey.token, allocation };
```

Update the return type annotation to include `adminKey: string`. (Purely additive — existing callers destructure subsets.)

- [ ] **Step 1 — Implement admin auth** `src/engines/control/admin-auth.ts` (no behaviour test of its own; exercised through the routes test — it is a thin mirror of `oracle/auth.ts` for the `sk_live_` class):

```ts
import type pg from 'pg';
import { hashApiKey } from '../../lib/ids.js';

/**
 * Operator/P1 admin auth for the control + monitoring surface (doc 03 §9). The `sk_live_` org admin key
 * is fenced OUT of the agent hot path (oracle/auth.ts) and is the ONLY credential accepted here; an
 * `ag_live_` agent bearer is refused so an agent token can never actuate a kill-switch. Resolves to the
 * owning org via the unique `orgs.admin_key_hash`.
 */
export type AdminOutcome = { ok: true; orgId: string } | { ok: false; code: 401; reason: string };

const BEARER_PREFIX = 'Bearer ';

export async function authenticateAdmin(pool: pg.Pool, authzHeader: string | undefined): Promise<AdminOutcome> {
  if (!authzHeader || !authzHeader.startsWith(BEARER_PREFIX)) {
    return { ok: false, code: 401, reason: 'missing_bearer_token' };
  }
  const token = authzHeader.slice(BEARER_PREFIX.length).trim();
  if (!token.startsWith('sk_')) return { ok: false, code: 401, reason: 'admin_key_required' };
  const res = await pool.query<{ id: string }>('SELECT id FROM orgs WHERE admin_key_hash = $1', [
    hashApiKey(token),
  ]);
  const row = res.rows[0];
  if (!row) return { ok: false, code: 401, reason: 'invalid_admin_key' };
  return { ok: true, orgId: row.id };
}
```

- [ ] **Step 2 — Write the failing routes test** `test/monitoring/routes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createOrg } from '../../src/engines/control/store.js';
import { issueAdminKey } from '../../src/lib/ids.js';
import { emitDecisionSafe } from '../../src/engines/monitoring/telemetry.js';
import {
  startStores, stopStores, buildOracleApp, seedAgent, raw402, requestContext, type Stores,
} from '../helpers/oracle-harness.js';

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
beforeAll(async () => { stores = await startStores(); if (stores) app = buildOracleApp(stores.pool, stores.redis); }, 180_000);
afterAll(async () => { await app?.close(); await stopStores(stores); });

/** Seed an org with a known admin key we control, returning the sk_ token. */
async function seedOrgAdmin(): Promise<{ orgId: string; sk: string }> {
  const key = issueAdminKey();
  const org = await createOrg(stores!.pool, { name: 'Mon', adminKeyHash: key.hash });
  return { orgId: org.id, sk: key.token };
}

describe('E8 monitoring HTTP surface (engine-specs-FINAL.md:256,258)', () => {
  it('GET /v1/monitoring/decisions requires the sk_ admin key and returns the redacted feed', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, sk } = await seedOrgAdmin();
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_r1', agentId: 'agt_r1', orgId, outcome: 'ALLOW',
      railScheme: 'raw-x402', railChain: 'arc', resourceId: 'svc:weather', amount: '5000000', ts: 1,
    });

    const noauth = await app.inject({ method: 'GET', url: '/v1/monitoring/decisions' });
    expect(noauth.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'GET', url: '/v1/monitoring/decisions?limit=10', headers: { authorization: `Bearer ${sk}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ decisions: Array<{ paymentId: string }> }>();
    expect(body.decisions[0]?.paymentId).toBe('pay_r1');
    expect(ok.body).not.toMatch(/signature|x_payment/i);
  });

  it('SSE once-mode returns text/event-stream backlog frames (admin-authed)', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { orgId, sk } = await seedOrgAdmin();
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_s1', agentId: 'agt_s1', orgId, outcome: 'DENY', reason: 'spend_cap_exceeded',
      railScheme: 'raw-x402', railChain: 'arc', resourceId: 'svc:weather', amount: '5000000', ts: 1,
    });
    const res = await app.inject({
      method: 'GET', url: '/v1/monitoring/decisions/stream?once=1', headers: { authorization: `Bearer ${sk}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.body).toContain('data:');
    expect(res.body).toContain('pay_s1');
    expect(res.body).not.toMatch(/signature|x_payment/i);
  });

  it('POST/DELETE /v1/admin/kill-switch is auth-fenced and drives the authorize path end-to-end', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const authorize = () => app!.inject({
      method: 'POST', url: '/v1/payment/authorize', headers: { authorization: `Bearer ${apiKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });

    // auth fence: no bearer and an ag_ bearer are both refused (only the operator sk_ may actuate).
    expect((await app.inject({ method: 'POST', url: '/v1/admin/kill-switch' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: '/v1/admin/kill-switch', headers: { authorization: `Bearer ${apiKey}` },
    })).statusCode).toBe(401);

    expect((await authorize()).statusCode).toBe(200); // baseline ALLOW

    const set = await app.inject({
      method: 'POST', url: '/v1/admin/kill-switch', headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ org_suspended: boolean }>().org_suspended).toBe(true);
    const denied = await authorize();
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string }>().error).toBe('org_suspended');

    const clear = await app.inject({
      method: 'DELETE', url: '/v1/admin/kill-switch', headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(clear.statusCode).toBe(200);
    expect((await authorize()).statusCode).toBe(200); // restored
  });

  it('POST /v1/admin/agents/:id/suspend (Tier-2) is tenant-fenced; unknown id → 404', async ({ skip }) => {
    if (!stores || !app) return skip();
    const { agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10);
    const hit = await app.inject({
      method: 'POST', url: `/v1/admin/agents/${agentId}/suspend`, headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(hit.statusCode).toBe(200);
    const miss = await app.inject({
      method: 'POST', url: '/v1/admin/agents/agt_nope/suspend', headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(miss.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3 — Run it, verify RED.** `npx vitest run test/monitoring/routes.test.ts` → FAIL (`routes.js` missing / routes unregistered).

- [ ] **Step 4 — Implement** `src/engines/monitoring/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { authenticateAdmin } from '../control/admin-auth.js';
import { setOrgKillSwitch, clearOrgKillSwitch, suspendAgent, reinstateAgent } from '../control/kill-switch.js';
import { readRecentDecisions, type DecisionEntry } from './telemetry.js';

/**
 * E8 read-side surface + the P1-actuated control routes (engine-specs-FINAL.md:256,258). All routes are
 * org-scoped via the sk_live_ admin key; the read feed respects org isolation (:268). NONE of these sit
 * on the agent hot path. The kill-switch / suspend routes are the operator (P1) actuation of the Tier-3 /
 * Tier-2 graded brakes; Monitoring surfaces, the operator actuates (BUG-15).
 */

function clampLimit(q: unknown): number {
  const raw = (q as { limit?: string } | undefined)?.limit;
  const n = raw ? Number(raw) : 50;
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.trunc(n));
}

function sseFrames(decisions: DecisionEntry[]): string {
  // Oldest→newest so a consumer replays in chronological order.
  return [...decisions].reverse().map((d) => `data: ${JSON.stringify(d)}\n\n`).join('');
}

export function registerMonitoringRoutes(app: FastifyInstance): void {
  app.get('/v1/monitoring/decisions', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const admin = await authenticateAdmin(pool, request.headers.authorization);
    if (!admin.ok) return reply.code(admin.code).send({ error: admin.reason });
    const decisions = await readRecentDecisions(redis, admin.orgId, clampLimit(request.query));
    return reply.code(200).send({ decisions });
  });

  app.get('/v1/monitoring/decisions/stream', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const admin = await authenticateAdmin(pool, request.headers.authorization);
    if (!admin.ok) return reply.code(admin.code).send({ error: admin.reason });
    const decisions = await readRecentDecisions(redis, admin.orgId, clampLimit(request.query));
    // Thin SSE: `?once=1` returns the backlog as a bounded event-stream body (deterministic, testable).
    // The live tail (default) is the same readRecentDecisions backlog followed by an XREAD BLOCK loop;
    // kept minimal for Phase-1 (the dashboard polls `?once=1` or consumes the live tail).
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    return reply.send(sseFrames(decisions));
  });

  app.post('/v1/admin/kill-switch', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const admin = await authenticateAdmin(pool, request.headers.authorization);
    if (!admin.ok) return reply.code(admin.code).send({ error: admin.reason });
    await setOrgKillSwitch(redis, admin.orgId);
    return reply.code(200).send({ org_suspended: true });
  });

  app.delete('/v1/admin/kill-switch', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const admin = await authenticateAdmin(pool, request.headers.authorization);
    if (!admin.ok) return reply.code(admin.code).send({ error: admin.reason });
    await clearOrgKillSwitch(redis, admin.orgId);
    return reply.code(200).send({ org_suspended: false });
  });

  app.post('/v1/admin/agents/:agentId/suspend', async (request, reply) => {
    const { pg: pool } = app.deps;
    const admin = await authenticateAdmin(pool, request.headers.authorization);
    if (!admin.ok) return reply.code(admin.code).send({ error: admin.reason });
    const { agentId } = request.params as { agentId: string };
    const changed = await suspendAgent(pool, { agentId, orgId: admin.orgId });
    return changed ? reply.code(200).send({ suspended: true }) : reply.code(404).send({ error: 'agent_not_found' });
  });

  app.delete('/v1/admin/agents/:agentId/suspend', async (request, reply) => {
    const { pg: pool } = app.deps;
    const admin = await authenticateAdmin(pool, request.headers.authorization);
    if (!admin.ok) return reply.code(admin.code).send({ error: admin.reason });
    const { agentId } = request.params as { agentId: string };
    const changed = await reinstateAgent(pool, { agentId, orgId: admin.orgId });
    return changed ? reply.code(200).send({ suspended: false }) : reply.code(404).send({ error: 'agent_not_found' });
  });
}
```

- [ ] **Step 5 — Register in `src/app.ts`.** Import and call after `registerAuthorizeRoute(app)`:

```ts
import { registerMonitoringRoutes } from './engines/monitoring/routes.js';
// …
  // E9 Oracle — the agent-egress authorize surface.
  registerAuthorizeRoute(app);
  // E8 Monitoring — read-side feed + P1-actuated graded brakes (off the hot path).
  registerMonitoringRoutes(app);
```

- [ ] **Step 6 — Write the structural decouple invariant** `test/invariant/monitoring-decoupled.test.ts` (pure; always runs):

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * INVARIANT (engine-specs-FINAL.md:249,264,327): Monitoring is read-side, NEVER on the hot path, and
 * depended on by NOTHING — its failure must never block spend. So the money-decision core (P2 Resolution
 * quote-assembly + P3 Enforcement decide/sign) must contain NO dependency edge to the monitoring module.
 *
 * The ORACLE (E9) legitimately imports monitoring to emit the fail-open C-10 copy (the spec's "all planes
 * → Monitoring" edge, :60); `emitDecisionSafe` never rejects, so that emit cannot block spend. The oracle
 * is therefore NOT scanned. We assert the ABSENCE of an import edge (not a comment mention). cwd-independent
 * via import.meta.url + anti-vacuous guards.
 */
describe('Monitoring is decoupled from the money-decision core (engine-specs-FINAL.md:249,264,327)', () => {
  it('no enforcement/resolution module imports the monitoring engine', () => {
    const enginesRoot = fileURLToPath(new URL('../../src/engines/', import.meta.url));
    const coreDirs = ['enforcement', 'resolution'].map((d) => join(enginesRoot, d));
    const offenders: string[] = [];
    let filesScanned = 0;
    const importEdge = /from\s+['"][^'"]*monitoring/;
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (entry.name.endsWith('.ts')) {
          filesScanned += 1;
          if (importEdge.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    for (const dir of coreDirs) expect(existsSync(dir), `missing core dir ${dir}`).toBe(true);
    coreDirs.forEach(scan);
    expect(filesScanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 7 — Run both, verify GREEN.** `npx vitest run test/monitoring/routes.test.ts test/invariant/monitoring-decoupled.test.ts`.

- [ ] **Step 8 — Full gate** (all + tsc + eslint + build). Mark checkbox + append `log-server` (`M8.L3 · …`).

---

## Task L4 — teardown reclaim-fence (close the M6 / SPIKE-03 deferral) — ✅ DONE (green: 52 files/156+2)

**Files:**
- Modify: `src/engines/provisioning/teardown.ts` (suspend the agent BEFORE the sweep + reclaim)
- Test: `test/provisioning/teardown-fence.test.ts`

- [ ] **Step 1 — Write the failing test** `test/provisioning/teardown-fence.test.ts`. Model the float/gateway setup on the existing `test/provisioning/teardown-sweep.test.ts` (read it first to mirror `ProvisionDeps` + the recording GatewayClient + how `floatConfirmed`/`allocationCommitted` are seeded). The new assertions:

```ts
// … startStores + seedAgent + set floatConfirmed/allocationCommitted as in teardown-sweep.test.ts …
import { teardownAgent } from '../../src/engines/provisioning/teardown.js';
import { authenticateAgent } from '../../src/engines/oracle/auth.js';

it('suspends the agent BEFORE reclaiming float, and the fence persists (SPIKE-03, teardown.ts:24)', async ({ skip }) => {
  if (!stores) return skip();
  const { orgId, agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);
  await stores.redis.set(keys.floatConfirmed(agentId), (25n * USDC).toString());
  await stores.redis.set(keys.allocationCommitted(orgId), (25n * USDC).toString());

  const statusAtReclaim: string[] = [];
  const gateway = {
    // record the agent's status AT THE MOMENT reclaim is called → proves suspend ordered first
    reclaimFor: async ({ amount }: { orgId: string; agentId: string; amount: bigint }) => {
      const r = await stores!.pool.query<{ status: string }>('SELECT status FROM agents WHERE id = $1', [agentId]);
      statusAtReclaim.push(r.rows[0]?.status ?? 'missing');
      void amount;
    },
    // isFinal/etc. unused here (no pending allocations seeded)
  } as unknown as Parameters<typeof teardownAgent>[0]['gateway'];

  const res = await teardownAgent({ pool: stores.pool, redis: stores.redis, gateway }, { orgId, agentId, now: 1_800_000_000 });

  expect(res.withdrawn).toBe(25n * USDC);          // reclaim still happens
  expect(statusAtReclaim).toEqual(['suspended']);  // … but only AFTER the fence is up
  const auth = await authenticateAgent(stores.pool, `Bearer ${apiKey}`);
  expect(auth.ok).toBe(false);
  if (!auth.ok) expect(auth.reason).toBe('agent_suspended'); // fence persists post-teardown
});
```

- [ ] **Step 2 — Run it, verify RED.** `npx vitest run test/provisioning/teardown-fence.test.ts` → FAIL: `statusAtReclaim` is `['active']` (reclaim runs before any suspend) and `auth.ok` is `true`.

- [ ] **Step 3 — Implement the fence.** In `src/engines/provisioning/teardown.ts`, add the import and a step 0 at the top of `teardownAgent` (before the pending sweep):

```ts
import { suspendAgent } from '../control/kill-switch.js';
```

```ts
  const { pool, redis, gateway } = deps;
  const { orgId, agentId, now } = params;

  // 0. FENCE (SPIKE-03 open question, teardown.ts header / M8): suspend the agent BEFORE sweeping and
  //    reclaiming, so a concurrent authorize is DENIED (agent_suspended, auth.ts:56) and cannot race the
  //    float_confirmed reclaim. Closes the M6-deferred "spend racing teardown" gap. Tenant-fenced; an
  //    unknown id is a no-op. The mempool-cancel-vs-await finality safety decision remains SPIKE-03.
  await suspendAgent(pool, { agentId, orgId });

  // 1. Sweep every in-flight pending allocation … (unchanged)
```

- [ ] **Step 4 — Run it, verify GREEN.** `npx vitest run test/provisioning/teardown-fence.test.ts` → PASS. Re-run the existing `test/provisioning/teardown-sweep.test.ts` to confirm the added suspend did not regress the sweep/reclaim accounting.

- [ ] **Step 5 — Full gate** (all + tsc + eslint + build). Mark checkbox + append `log-server` (`M8.L4 · …`). Update the `teardown.ts` header to note the fence is now wired (was deferred).

---

## M8 adversarial review (Challenge Protocol) — ✅ DONE (3 FIXED + 1 partial; green 52 files/157+2)

After L1-L4 are green, run an independent reviewer over the M8 paths and apply the Challenge Protocol (Weakness / Counter / Decision per finding; inflated scores = REJECT). Focus the review on:

1. **Fail-open is real, not nominal.** `emitDecisionSafe` must never reject under ANY thrown/rejected path (not just the simulated one). Confirm the oracle awaits it and still returns the decision on a Redis-down emit.
2. **No raw bytes anywhere new.** The stream copy + the feed + the SSE frames must never carry `signature`/`x_payment`. Confirm the contract has no such field AND no field is populated from the X-PAYMENT or signature.
3. **Tenant isolation.** The feed + control routes are strictly org-scoped (no cross-org read or actuation); the agent-suspend UPDATE is `(id, org_id)`-fenced.
4. **No new hot-path dependency / no decision coupling.** The structural guard holds; awaiting the emit adds no NEW availability dependency beyond Redis (already a money-op dependency).
5. **Kill-switch semantics.** `denyAll` carries no TTL (fail-closed); it freezes P3-A and P3-B; clear is the only lift.
6. **Teardown ordering.** Suspend is strictly before reclaim; the fence persists; the existing sweep accounting is unregressed.

Record verdicts in this file (FIXED / REJECTED-after-spec-reread / PASS-with-acknowledgment), fix what's real red-test-first, re-run the full gate, then close task #25.

### Findings & verdicts (as-run) — independent reviewer, Challenge Protocol applied

4 findings (3 MED, 1 LOW). 3 FIXED, 1 partially-fixed-1-rejected-arm. No HIGH / no money-loss defect. The reviewer empirically confirmed the load-bearing invariants hold (redaction `[redacted]`, SSE-injection safety via `JSON.stringify` newline-escaping, kill-switch key coordination across P3-A/P3-B, `clampLimit` fuzzing, non-vacuous decouple guard, correct `paymentId` fallback, ioredis `xadd`/MAXLEN).

- **#1 [MED] Fail-open broken by a *slow/hung* (not rejecting) Redis — the oracle `await`ed the emit on a committed-payment's response path → FIXED.** `emitDecisionSafe` only catches rejections; a hung `xadd` would stall the response of an already-committed payment — the inverse dependency the spec forbids (:264). Fix: the emit is now **fire-and-forget** (`void emitDecisionSafe(...)`, authorize.ts step 7) — which is also the more spec-faithful reading of C-10 "async, copy" (:60). The copy is rebuildable from P4, so a dropped emit costs visibility only. Added an e2e test (routes.test.ts) proving an ALLOW authorize lands a redacted copy on the feed (bounded poll, since the emit is now async).
- **#2 [MED] `orgs.admin_key_hash` had no UNIQUE constraint while `authenticateAdmin` assumes one (and its comment claimed "unique") → FIXED.** Added migration `0004_admin_key_unique.sql` (`CREATE UNIQUE INDEX orgs_admin_key_hash_idx`), mirroring `agents.api_key_hash`. Tenant isolation on the auth credential is now schema-enforced (fail-closed at write), not assumed; the comment is now true.
- **#3 [MED] The fence blocks only NEW authorizes, not a spend already in-flight past the auth gate; header/test overstated "cannot race the reclaim" → FIXED (claim) + REJECTED (abort-on-false arm).** Tightened the teardown header, the step-0 comment, and the fence test to scope the guarantee honestly: M8 closes the **new-spend** arm; draining an in-flight spend against the reclaim needs BROADCASTING→finality tracking and stays SPIKE-03 / M9. **Rejected** the reviewer's "abort teardown if `suspendAgent` returns false": aborting would STRAND any Redis float for that id — proceeding to reclaim is strictly safer; documented why the boolean is intentionally not used to abort.
- **#4 [LOW] SSE `?once=1` was ignored and the comment described an unimplemented live tail → FIXED.** Rewrote the comment to match reality (a **bounded `text/event-stream` snapshot**; the continuous XREAD BLOCK tail is the additive M9 enhancement, same key) and dropped the no-op `?once=1` from the test.

Post-fix gate: full suite **52 files / 157 passed + 2 skipped**; typecheck + lint + build clean.

---

## Acceptance

- [ ] Every authorize decision (ALLOW/DENY/DUPLICATE) emits a redacted C-10 copy to `authorizeStream`, fail-open.
- [ ] `GET /v1/monitoring/decisions` + SSE serve the redacted feed, admin-authed, org-scoped.
- [ ] Tier-3 `DENY_ALL` set/clear drives the existing P3-A/P3-B gate (ALLOW↔DENY proven end-to-end); Tier-2 suspend drives auth.ts.
- [ ] The money-decision core (enforcement + resolution) imports no monitoring module (structural guard green).
- [ ] Teardown suspends the agent before reclaim; the fence persists; SPIKE-03's "spend racing teardown" question is closed (mempool-cancel-vs-await still deferred).
- [ ] Full suite + typecheck + lint + build green; `log-server` appended per chunk; nothing committed.

## Deferred (cited, carried forward)

- Tier-1 `anomaly_flag` advisory speed-bump (needs a P3-A advisory read namespace) + Tier-4 emergency treasury 2-of-3 lock — engine-specs-FINAL.md:256.
- Burn-rate / velocity analytics, alerting pipeline, dead-man's-switch heartbeat — :254,268 (dashboard enrichment, M9 / frontend).
- MFA on Tier-3 actuation — :256 (auth hardening, M9).
- Additional C-10 event types (state-transition, sign, settlement, allocation, reputation-post) — additive to the same sink, emitted at their planes when those dashboards land.
- Fully async telemetry tailer (project P4 → stream off-request) — the fail-open await already makes the emit non-blocking; a background tailer is a later hardening.
- SPIKE-03 mempool-cancel-vs-await finality safety + concurrent-spend reconciliation beyond the fence.
