# M6 — Provisioning (E5) + Domain-Binding recipient guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, JIT — the locked loop used for M2–M5). Steps use checkbox (`- [ ]`) syntax. L1 is fully detailed (executes first); L2–L6 carry precise interfaces/invariants/acceptance and get their bite-sized step expansion at execution time (SPIKE-02/03 constants are not knowable until those spikes run, so they are deliberately not frozen here).

**Goal:** Close the spend-path recipient gap with the spec-correct mechanism (the E7 Domain Binding Verifier, BUG-17), then build E5 Provisioning — `depositFor` (P3-B-gated, treasury-allocation role), two-phase float confirm, top-up, teardown sweep, and the dynamic replenishment watermark.

**Architecture:** Recipient binding is NOT `AllocationPolicy.allowedDestinations` (that is the *depositFor* own-agents fence, already enforced in `allocation-eval.ts`). The spend path binds `payTo` to the vendor domain by independently fetching `https://{host}/.well-known/agentops.json` and matching the published address — fail-closed `destination_unverified`. Provisioning then funds per-agent floats through the same atomic P3-B reserve the spec already defines, with the two-phase `float_pending → float_confirmed` promotion gated on on-chain finality (pending float is never spendable).

**Tech Stack:** Node20 + TS strict (NodeNext ESM, `.js` import specifiers, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · Fastify · pg · ioredis (Lua via `defineCommand`) · viem · zod · Vitest + Testcontainers (postgres:16-alpine, redis:7-alpine). On-chain reads/writes stay behind seams so engines are Testcontainers-only; the network-backed impls (`.well-known` fetch, Gateway client) are the sole creds-gated layer, wired in `server.ts`.

---

## Why L1 is Domain-Binding, not `allowedDestinations` (M5-review Challenge resolution)

The M5 adversarial review flagged that the spend path signs against an agent-asserted `quote.destination` / `quote.verifyingContract` with no recipient allowlist, and my close-out note tied the fix to `AllocationPolicy.allowedDestinations`. That was a conflation:

- **`allowed_destinations[]` is the depositFor fence** — "own agents only, never external" (policy-engine-FINAL.md:128, :202; engine-specs §P3-B). Already enforced correctly in `allocation-eval.ts:68`. Vendor `payTo` addresses are discovered dynamically per-402 and can never live in a static treasury fence.
- **The spend-path recipient binding is the Domain Binding Verifier** (policy-engine-FINAL.md:282, BUG-17): fetch the vendor's `.well-known/agentops.json`, verify `payTo` matches the domain's published address, else `DESTINATION_UNVERIFIED` deny (fail-closed, 100ms hard timeout, 5-min cache). Canonically an E7 component sequenced into M7 — but M7 already lands before M9 (first funded broadcast), so this is safe to pull forward without forking the spec.

**Decision (user-confirmed):** pull the Domain Binding Verifier forward as **M6.L1**, then build E5 Provisioning (L2–L6). ServiceScope (M5, P3-A) already bounds *which domain*; L1 binds *the payTo to that domain*.

---

## File Structure / touch map

```
src/
  contracts/index.ts            MODIFY  +DenyReason 'destination_unverified'; +Quote.originHost
  engines/resolution/parse-402.ts MODIFY  set Quote.originHost = host(ctx.url)
  engines/identity/
    domain-binding.ts           CREATE  DomainRegistry seam + verifyDomainBinding (cache + fail-closed)
  lib/identity/
    well-known-registry.ts      CREATE  network-backed DomainRegistry (.well-known fetch, 100ms AbortController) — creds/network layer, wired in server.ts only
  redis/keyspace.ts             MODIFY  +keys.domainBinding(host)
  engines/enforcement/enforce.ts MODIFY  +EnforceDeps.domainRegistry; step 4b domain-binding gate
  app.ts                        MODIFY  +HotPathDeps.domainRegistry
  engines/oracle/authorize.ts   MODIFY  pass hotPath.domainRegistry into EnforceDeps
  server.ts                     MODIFY  construct the network-backed registry (L1 final wiring)
  engines/provisioning/
    deposit.ts                  CREATE  depositFor / topup (P3-B-gated, treasury-allocation role, float_pending)   [L2/L4]
    confirm.ts                  CREATE  two-phase finality promotion pending→confirmed; reserved→committed         [L3]
    teardown.ts                 CREATE  teardown sweep of pending depositFor (BUG-21)                                [L5]
    watermark.ts                CREATE  dynamic replenishment watermark (NFR-05)                                     [L6]

test/
  identity/domain-binding.test.ts          CREATE  L1 unit (cache hit / cold-fetch+cache / mismatch / null → unverified)
  enforcement/enforce-domain-binding.test.ts CREATE  L1 integration (mismatch → DENY destination_unverified, no reserve)
  resolution/parse-402-rail-detect.test.ts MODIFY  +assert originHost
  provisioning/depositfor-allocation-gated.test.ts CREATE  [L2]
  custody/two-phase-float.test.ts          CREATE  [L3]
  provisioning/topup-raises-spendable.test.ts CREATE  [L4]
  provisioning/teardown-sweeps-pending.test.ts CREATE  [L5]
  provisioning/watermark.test.ts           CREATE  [L6 / SPIKE-02]
  helpers/oracle-harness.ts                MODIFY  +domainRegistry stub + bindAnyTo helper; wire into buildOracleApp hotPath
```

---

## M6.L1 — Domain Binding Verifier (E7/BUG-17 recipient guard)

**Files:**
- Modify: `src/contracts/index.ts` (DenyReason union; Quote.originHost)
- Modify: `src/engines/resolution/parse-402.ts`
- Modify: `src/redis/keyspace.ts`
- Create: `src/engines/identity/domain-binding.ts`
- Create: `src/lib/identity/well-known-registry.ts`
- Modify: `src/engines/enforcement/enforce.ts`, `src/app.ts`, `src/engines/oracle/authorize.ts`, `src/server.ts`
- Modify: `test/helpers/oracle-harness.ts`
- Test: `test/identity/domain-binding.test.ts`, `test/enforcement/enforce-domain-binding.test.ts`, `test/resolution/parse-402-rail-detect.test.ts`

- [ ] **Step 1: Extend the contracts.** In `src/contracts/index.ts` add `'destination_unverified'` to the `DenyReason` union, and add `originHost` to `Quote`:

```ts
export type DenyReason =
  | 'spend_cap_exceeded'
  | 'allocation_exceeded'
  | 'per_transaction_max_exceeded'
  | 'velocity_exceeded'
  | 'service_not_allowed'
  | 'rail_not_permitted'
  | 'org_suspended'
  | 'destination_unverified';
```

```ts
  // (inside Quote, after x402Network)
  /**
   * The vendor host the agent called to receive this 402 (from request_context.url). The Domain
   * Binding Verifier (E7/BUG-17) fetches https://{originHost}/.well-known/agentops.json and requires
   * the published address to match {@link destination}; otherwise the spend is DENIED
   * (`destination_unverified`). Empty string if the URL was unparseable → fail-closed deny.
   */
  originHost: string;
```

Also re-tighten the M5 "unchecked until M6" comment on `Quote.verifyingContract`: state that the *destination* is now bound by the Domain Binding Verifier (L1), while the *token* (`verifyingContract`) allowlist remains a designed-for harden item (the EIP-5267 ladder already rejects an un-resolvable token via `UnsupportedTokenError`).

- [ ] **Step 2: Set `originHost` in `parse402`.** Add a host helper and populate the field:

```ts
/** Vendor host for the Domain Binding Verifier (E7). Empty string on an unparseable URL → fail-closed. */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}
```
In the returned quote object add `originHost: hostOf(ctx.url),`.

- [ ] **Step 3: Add the keyspace key.** In `src/redis/keyspace.ts`, inside `keys`:

```ts
  /** Domain-binding cache: vendor host -> published payTo (5-min TTL); E7 recipient binding (BUG-17). */
  domainBinding: (host: string) => `domain_binding:${host}`,
```

- [ ] **Step 4: Write the failing unit test** `test/identity/domain-binding.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Redis } from 'ioredis';
import { verifyDomainBinding, type DomainRegistry } from '../../src/engines/identity/domain-binding.js';
import { keys } from '../../src/redis/keyspace.js';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

/**
 * E7 Domain Binding Verifier (policy-engine-FINAL.md:282, BUG-17). The 402's payTo MUST match the
 * address the vendor domain publishes at .well-known/agentops.json. Fail-closed: an unverifiable or
 * mismatched destination is DENIED. A positive domain record is cached 5 min; failures/mismatches are
 * never cached (a transient registry outage self-heals and never silently widens who an agent may pay).
 */

const HOST = 'api.vendor.test';
const REGISTERED = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa';

let s: Stores | null = null;
let redis: Redis;
beforeAll(async () => {
  s = await startStores();
  if (!s) return;
  redis = s.redis;
});
afterAll(async () => stopStores(s));

const calls = (recorded: string[]): DomainRegistry => ({
  resolvePaymentAddress: (host) => {
    recorded.push(host);
    return Promise.resolve(host === HOST ? REGISTERED : null);
  },
});

describe.skipIf(!process.env.CI && false)('verifyDomainBinding', () => {
  it.skipIf(() => s === null)('binds a payTo that matches the published address (case-insensitive)', async () => {
    const seen: string[] = [];
    const r = await verifyDomainBinding(redis, calls(seen), { host: HOST, payTo: REGISTERED.toLowerCase() });
    expect(r.bound).toBe(true);
    expect(seen).toEqual([HOST]); // cold fetch happened once
  });

  it.skipIf(() => s === null)('serves the second lookup from the 5-min cache (no second fetch)', async () => {
    const seen: string[] = [];
    await verifyDomainBinding(redis, calls(seen), { host: HOST, payTo: REGISTERED });
    await verifyDomainBinding(redis, calls(seen), { host: HOST, payTo: REGISTERED });
    expect(seen.length).toBe(1);
    expect(await redis.ttl(keys.domainBinding(HOST))).toBeGreaterThan(0);
  });

  it.skipIf(() => s === null)('DENIES a payTo that does not match the published address', async () => {
    const r = await verifyDomainBinding(redis, calls([]), { host: HOST, payTo: '0xbeef000000000000000000000000000000000000' });
    expect(r).toEqual({ bound: false, reason: 'destination_unverified' });
  });

  it.skipIf(() => s === null)('DENIES (fail-closed) when the registry returns null and does NOT cache it', async () => {
    const r = await verifyDomainBinding(redis, calls([]), { host: 'unknown.test', payTo: REGISTERED });
    expect(r).toEqual({ bound: false, reason: 'destination_unverified' });
    expect(await redis.get(keys.domainBinding('unknown.test'))).toBeNull();
  });

  it.skipIf(() => s === null)('DENIES an empty host or payTo without touching the registry', async () => {
    const seen: string[] = [];
    expect((await verifyDomainBinding(redis, calls(seen), { host: '', payTo: REGISTERED })).bound).toBe(false);
    expect(seen.length).toBe(0);
  });
});
```
(If the established harness pattern is a plain `if (!s) return` guard rather than `it.skipIf`, mirror that — match the existing M3/M5 container-guard idiom exactly.)

- [ ] **Step 5: Run it — expect RED** (`verifyDomainBinding` not defined / module missing).

Run: `npx vitest run test/identity/domain-binding.test.ts`
Expected: FAIL (cannot find module `domain-binding.js`).

- [ ] **Step 6: Implement** `src/engines/identity/domain-binding.ts`:

```ts
import type { Redis } from 'ioredis';
import type { DenyReason } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';

/**
 * E7 Domain Binding Verifier (policy-engine-FINAL.md:282, BUG-17). Closes the spend-path recipient
 * gap: agentOps independently confirms the 402's payTo matches the address the vendor domain publishes
 * at https://{host}/.well-known/agentops.json, so a compromised agent cannot redirect a policy-valid
 * spend to an attacker address. ServiceScope (P3-A) already bounds WHICH domain may be paid; this binds
 * the payTo TO that domain. Fail-closed: an unverifiable destination is DENIED (destination_unverified).
 *
 * The hot path reads a 5-min Redis cache; a cold miss does one bounded (100ms) registry fetch whose
 * timeout lives in the network-backed impl. A positive domain record is cached; a failure/timeout is
 * NOT cached, so a transient outage self-heals next request and never silently widens the recipient set.
 */

const DOMAIN_BINDING_TTL_SECONDS = 5 * 60;

export interface DomainRegistry {
  /**
   * Resolve the vendor's published payment address for `host` (the .well-known/agentops.json fetch).
   * MUST enforce a hard 100ms timeout and return null on timeout / fetch failure / absent record —
   * the caller treats null as fail-closed. Should not throw (a throw is still handled fail-closed).
   */
  resolvePaymentAddress(host: string): Promise<string | null>;
}

export type BindingResult =
  | { bound: true }
  | { bound: false; reason: Extract<DenyReason, 'destination_unverified'> };

const UNVERIFIED: BindingResult = { bound: false, reason: 'destination_unverified' };

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function verifyDomainBinding(
  redis: Redis,
  registry: DomainRegistry,
  params: { host: string; payTo: string },
): Promise<BindingResult> {
  const { host, payTo } = params;
  if (host.length === 0 || payTo.length === 0) return UNVERIFIED;

  const cacheKey = keys.domainBinding(host);
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return sameAddress(cached, payTo) ? { bound: true } : UNVERIFIED;
  }

  let registered: string | null;
  try {
    registered = await registry.resolvePaymentAddress(host);
  } catch {
    return UNVERIFIED; // defense-in-depth: a throwing impl is still fail-closed.
  }
  if (registered === null || registered.length === 0) return UNVERIFIED;

  // Cache the DOMAIN's published address (a property of the domain), then compare per-request.
  await redis.set(cacheKey, registered.toLowerCase(), 'EX', DOMAIN_BINDING_TTL_SECONDS);
  return sameAddress(registered, payTo) ? { bound: true } : UNVERIFIED;
}
```

- [ ] **Step 7: Run the unit test — expect GREEN.** `npx vitest run test/identity/domain-binding.test.ts`

- [ ] **Step 8: Write the failing integration test** `test/enforcement/enforce-domain-binding.test.ts` — drive `enforceSpend` with a quote whose `originHost` resolves to a DIFFERENT address than `quote.destination`; assert `{ outcome: 'DENY', reason: 'destination_unverified' }`, the `reserved` counter is `"0"` / absent, `windowSum` is `0n`, no grant claim, no payment hash. Then a matching-address case → reaches the reserve/sign path (ALLOW). Reuse the oracle-harness (`startStores`, `seedAgent`, `signer`, `tokenDomainSource`, `usdc`); build a quote with `originHost: 'api.vendor.test'` and a `domainRegistry` stub binding that host to the seeded VENDOR. Run → expect RED (no domain-binding gate yet; the mismatch currently reaches signing).

- [ ] **Step 9: Wire the gate into `enforce.ts`.** Add to `EnforceDeps`:

```ts
import { verifyDomainBinding, type DomainRegistry } from '../identity/domain-binding.js';
// ...
  /** E7 recipient binding (BUG-17): resolves the vendor's published payTo (.well-known); stubbed in tests. */
  domainRegistry: DomainRegistry;
```
Insert step **4b** immediately after the SpendPolicy deny block (after `if (!decision.allow) { ... return ... }`), BEFORE the grant claim — so a denied spend never incurs the registry fetch, and no recipient-unverified spend ever reserves:

```ts
  // 4b. Domain binding (BUG-17): the vendor domain must publish this payTo. A compromised agent must
  //     not redirect a policy-valid spend to an attacker address. Fail-closed; runs after the cheap
  //     SpendPolicy checks and before any reserve so the deny path still moves no money.
  const binding = await verifyDomainBinding(redis, deps.domainRegistry, {
    host: quote.originHost,
    payTo: quote.destination,
  });
  if (!binding.bound) {
    await recordDecision(pool, {
      paymentId,
      agentId,
      orgId,
      rail: quote.rail,
      resourceId: quote.resourceId,
      requested: quote.amount,
      policyRef,
      state: 'QUOTED',
      result: 'DENY',
      reasonCode: binding.reason,
      enforcementTimestamp: enforcedAt,
    });
    return { outcome: 'DENY', reason: binding.reason };
  }
```

- [ ] **Step 10: Thread `domainRegistry` through the wiring.** `HotPathDeps` (`src/app.ts`) gains `domainRegistry: DomainRegistry`; `authorize.ts` passes `domainRegistry: hotPath.domainRegistry` into the `enforceSpend` deps object. In `oracle-harness.ts` add:

```ts
import type { DomainRegistry } from '../../src/engines/identity/domain-binding.js';
// ...
/** Domain-binding stub: the test vendor host publishes VENDOR; everything else is unverified. */
export const domainRegistry: DomainRegistry = {
  resolvePaymentAddress: (host) => Promise.resolve(host === 'api.weather.example' ? VENDOR : null),
};
/** Permissive stub: binds any host to `addr` (for tests not exercising the binding gate itself). */
export const bindAnyTo = (addr: string): DomainRegistry => ({ resolvePaymentAddress: () => Promise.resolve(addr) });
```
Add `domainRegistry` to `buildOracleApp`'s `hotPath`. Update every existing direct `EnforceDeps` construction (grep `tokenDomainSource:` in `test/`) to include `domainRegistry: bindAnyTo(<that quote's destination>)`, and set `originHost` on every hand-built `Quote` (e.g. `enforce-release-on-throw.test.ts`) so those tests still reach their intended path. `requestContext.url` host is `api.weather.example`, which the stub binds to `VENDOR` (= raw402 payTo), so existing authorize ALLOW tests stay green.

- [ ] **Step 11: Add the `originHost` assertion** to `test/resolution/parse-402-rail-detect.test.ts` (the raw-x402 case): `expect(q.originHost).toBe('api.vendor.test')` (the host of `ctx.url`).

- [ ] **Step 12: Run integration test — expect GREEN**, then the full gate set.

Run: `npx vitest run` · `npm run typecheck` · `npm run lint` · `npm run build`
Expected: all green (suite grows by the two new files + the unit cases).

- [ ] **Step 13: Network-backed registry** `src/lib/identity/well-known-registry.ts` (the creds/network layer, NOT Testcontainers-tested — like the viem impls in `src/lib/arc/client.ts`). `fetch('https://' + host + '/.well-known/agentops.json', { signal: AbortSignal.timeout(100) })`, parse `{ payment_address }`, return it or null on any error/timeout/shape-miss. Construct it in `server.ts` and pass into `hotPath.domainRegistry`. Note in code that negative-result caching (anti-fetch-storm) is a deferred harden item.

- [ ] **Step 14: Mark L1, append `log-server`** (newest-at-bottom): the Challenge resolution (allowedDestinations ≠ spend-path; domain-binding = BUG-17/E7 pulled forward), the gate placement (4b, fail-closed, pre-reserve), files touched, and "M6.L1 domain-binding COMPLETE — next L2 depositFor."

---

## M6.L2 — `depositFor` (E5 Provisioning, P3-B-gated) — [x] DONE

**Files:** Create `src/engines/provisioning/deposit.ts`; Test `test/provisioning/depositfor-allocation-gated.test.ts`; Modify `src/redis/keyspace.ts` (+`keys.allocation`), `test/helpers/oracle-harness.ts` (fixture fence fix + return `allocation`).

**Reconciliation (3 carried conflict points, resolved at L2 start):**
- **CP1 — Gateway surface:** `src/lib/circle/gateway.ts` already exists. The real method is `depositFor({ orgId, agentId, amount: UsdcBaseUnits }): Promise<{ id }>` (NOT the assumed `depositFor(recipient, amount)`), and there is **no `isFinal`** — L3 must ADD `isFinal(txRef)` to that SAME single wrapper.
- **CP2 — fixture fence:** the shared `seedAgent` set `allowedDestinations: [VENDOR]`, wrong for the own-agents fence. Fixed to `[agentFloat.address]`; zero blast radius (the 7 `seedAgent` consumers are all spend-path/oracle tests that never read `allocation.allowedDestinations`; `allocation-budget.test.ts` builds its own policy literal). `seedAgent` now returns the seeded `allocation`.
- **CP3 — spendable:** confirmed `custody/balance.ts:computeSpendable = floatConfirmed − consumed − reserved − escrowReserved` already EXCLUDES `floatPending`.

**Challenge — REVISE on the assumed "treasury signs the internal allocation":** Circle Gateway is developer-controlled/custodial, so `gateway.depositFor` is API-authorized and takes **no client EIP-712 signature**. Manufacturing one would be dead code. Decision: L2 routes through the single wrapper with no client signature; the `treasury-allocation`/`internal-allocation` KMS fence (`signer.ts`, already unit-tested) governs the self-custody rail. The external-redirect threat is closed by `evaluateAllocation`'s own-agent destination fence + the custodial deposit-for endpoint. No spec fork (the fence still exists; we just don't fabricate a signature the custodial rail does not consume).

**Interface (as built):**
```ts
export interface ProvisionDeps { pool: pg.Pool; redis: Redis; gateway: GatewayClient; } // pool for L3 recordAllocation
export interface DepositForParams {
  orgId: string; agentId: string;
  agentFloatAddress: string;   // own-agent fence destination — must be in AllocationPolicy.allowedDestinations
  amount: bigint;
  policy: AllocationPolicy;
  kind: 'depositFor' | 'topup';
  secondsSinceLastAllocation: number | null;  // threaded for M6 cooldown/sibling_quota (not yet enforced)
  now: number;                                 // stored as submittedAt for L3's enforcement timestamp
}
export type DepositResult = { outcome: 'SUBMITTED'; allocationId: string } | { outcome: 'DENY'; reason: DenyReason };
```
**Flow / invariants (as built):**
1. `evaluateAllocation(redis, { orgId, agentId, requested: amount, destination: agentFloatAddress, secondsSinceLastAllocation, policy })` — P3-B: `deny_all`→`org_suspended`, `perAgentMax`→`allocation_exceeded`, own-agent fence→`service_not_allowed`, atomic `allocation_reserved` INCR. A DENY returns and moves nothing (never reaches Circle).
2. Submit through the single wrapper: `gateway.depositFor({ orgId, agentId, amount })` → `{ id }` (= `txRef`). On a submit throw, **compensate the reserve** (`DECRBY allocation_reserved`) and rethrow, so a transient network error never strands org budget.
3. `INCR float_pending` by amount ONLY (two-phase — pending is NEVER spendable, BUG-29). `float_confirmed` + `recordAllocation` wait for L3.
4. Persist an in-flight `allocation:{allocationId}` hash (agentId, orgId, amount, kind, txRef, state `PENDING`, submittedAt) so L3 can promote + record on finality. `allocationId = alloc_<uuid>`.

**Acceptance (met, 4/4):** external-destination → `service_not_allowed`; over-`perAgentMax` → `allocation_exceeded` (both move nothing, never call Circle); an allowed request reserves `allocation_reserved`, raises `float_pending`, writes the PENDING hash, calls the wrapper's `/v1/gateway/deposit-for`, and leaves spendable `0n` (pending excluded); a Gateway submit failure releases the reserve back to `0` with no pending float and no record.

## M6.L3 — Two-phase float confirm (finality promotion) — [x] DONE

**Files:** Create `src/engines/provisioning/confirm.ts`; Modify `src/lib/circle/gateway.ts` (+`isFinal`), `src/redis/lua/confirm-allocation.lua` (CREATE) + `load.ts` export; Test `test/custody/two-phase-float.test.ts`.

**As built:** `gateway.isFinal(txRef)` GETs `/v1/gateway/operations/{txRef}` → `status === 'complete'` (single wrapper, no second boundary). `confirmDeposit` reads the PENDING hash → absent/not-PENDING = `NOOP`; `isFinal` throws or false = `PENDING` (never promote on a blind timeout); final = single-winner `confirm-allocation.lua` (atomic state-check + float_pending→float_confirmed + allocation_reserved→allocation_committed) → winner alone runs `recordAllocation` + `del` the hash → `CONFIRMED`. **Acceptance (met, 3/3):** spendable rises only post-confirm; a finality-read failure holds PENDING with float untouched and the record intact; a replayed confirm is NOOP with exactly one balanced allocation_events pair.

**Interface:** `confirmDeposit(deps, { allocationId, now }): Promise<'CONFIRMED' | 'PENDING' | 'NOOP'>` (reuses `ProvisionDeps`).
**Carried from L2 (CP1):** the Gateway wrapper has NO finality method yet. L3 ADDS `isFinal(txRef): Promise<boolean>` to `GatewayClient` (the single wrapper — no second Circle boundary), backed by the on-chain finality read behind the existing seam; the engine stays Testcontainers-only by stubbing it like the L2 transport.
**Flow / invariants (mirrors expiry-check's finality gate):**
1. Read `allocation:{allocationId}`; absent / not-PENDING → `NOOP` (idempotent single-winner).
2. On-chain finality read via the wrapper (`gateway.isFinal(txRef)`): not final → `PENDING` (LOCKED; never promote on a blind timeout — BUG-39/42).
3. Final, single-winner guard: `DECR float_pending` + `INCR float_confirmed`; `DECR allocation_reserved` + `INCR allocation_committed`; `recordAllocation(pool, { kind, ... })` (cold double-entry, debit treasury / credit agent-float); `del allocation:{id}` → `CONFIRMED`.

**Acceptance:** before confirm, `computeSpendable = confirmed − consumed − reserved − escrow` excludes the pending deposit and any reserved hold; after confirm, spendable rises by the deposit; a replayed `confirmDeposit` is a no-op (no double promotion, exactly one allocation_events pair).

## M6.L4 — Top-up — [x] DONE

**Files:** reuse `deposit.ts` + `confirm.ts` (no new production code — the `kind` generalization landed in L2/L3); Test `test/provisioning/topup-raises-spendable.test.ts`.
A `kind: 'topup'` deposit on an agent with existing confirmed float, once confirmed (L3), raises spendable by the top-up amount. Same P3-B gate + two-phase path; the only delta is the ledger `kind`. **As built:** L4 needed zero new production code — it is the end-to-end topup scenario lock. **Acceptance (met, 1/1):** depositFor $50 confirmed then topup $30 confirmed → float_confirmed $80, spendable $80, allocation_committed $80, two independent allocation_events pairs (one `depositFor`, one `topup`), distinct allocation ids.

## M6.L5 — Teardown sweep (BUG-21, SPIKE-03)  — [x] DONE

**Files:** Create `src/engines/provisioning/teardown.ts`; Test `test/provisioning/teardown-sweep.test.ts` (renamed from the planned `…-sweeps-pending`).
**Interface:** `teardownAgent(deps, { orgId, agentId, now }): Promise<{ sweptPending: number; withdrawn: bigint }>`.
**Invariants:** sweep every in-flight `depositFor` so no stranded `float_pending` survives teardown (BUG-21) — either await finality then withdraw, or cancel in mempool (SPIKE-03 validates the sweep); withdraw remaining confirmed float to treasury (`recordAllocation` kind `teardown`); end state `float_pending == 0`.
**Acceptance:** teardown of an agent with a pending + a confirmed deposit leaves zero pending and a balanced teardown allocation pair.

**As built (reconciliations):**
- **Per-agent in-flight index added** (`keys.pendingAllocations(agentId)` = Redis SET): `deposit.ts` SADDs each submitted allocationId; `confirm.ts` SREMs on the winning promotion. Teardown enumerates this SET — `float_pending` alone could not be swept back to individual records.
- **Sweep:** for each PENDING id — `gateway.isFinal` true → `confirmDeposit` promotes it (then it joins the confirmed reclaim); not-final or unreadable → CANCEL via new single-winner `cancel-allocation.lua` (state==PENDING guard + DECRBY float_pending + DECRBY allocation_reserved + SREM index + DEL record), mirroring `confirm-allocation.lua` so a concurrent confirm vs cancel cannot double-act. Guarantees `float_pending == 0`.
- **Reclaim:** remaining `float_confirmed` → `gateway.reclaimFor` (NEW wrapper method on THE single `GatewayClient`, inverse of `depositFor`; placeholder path `/v1/gateway/reclaim-for` like the others — no real Circle endpoint invented, reconciled at M9), then DECRBY float_confirmed + DECRBY allocation_committed, then one `recordAllocation(kind:'teardown')` pair.
- **CHALLENGE applied:** `recordAllocation` hardcoded debit treasury / credit agent-float — WRONG for teardown (funds flow agent-float → treasury). Extended it to flip accounts by `kind` (teardown → debit agent-float / credit treasury); depositFor/topup unchanged, so L3/L4 ledger-direction assertions stay green.
- **SPIKE-03 OPEN (not frozen):** the cancel path is optimistic — a cancelled op that later settles on-chain credits untracked float. SPIKE-03 must choose mempool-cancel vs await-finality. Flagged in `teardown.ts` header + log-server. Second open question flagged: a spend racing teardown against `float_confirmed` (suspend agent / fence reclaim behind the M8 kill-switch).
- **Tests:** `teardown-sweep.test.ts` 2/2 — (1) cancel a still-pending + reclaim a confirmed → float_pending 0, float_confirmed 0, reserve/commit released, one reclaim call, teardown pair flips direction, cancelled deposit writes no ledger rows; (2) a now-final pending is PROMOTED during the sweep then reclaimed. Full suite 41 files/122 passed+2 skipped; typecheck+lint+build clean (8 lua copied).

## M6.L6 — Dynamic replenishment watermark (NFR-05, SPIKE-02)  — [x] DONE

**Files:** Create `src/engines/provisioning/watermark.ts`; Test `test/provisioning/watermark.test.ts`.
**Interface:** `computeWatermark(redis, { agentId, now, staticFloor, multiplier, window? }): Promise<bigint>` and `needsReplenish(spendable, watermark): boolean`.
**Formula (policy-engine-FINAL.md:178):** `watermark = max(STATIC_FLOOR, P × recent_velocity_burn_rate_per_window)`, burn rate derived from the agent's rolling P4 spend ZSET; default `P = 2×`. High-velocity agents get higher watermarks (prevents threshold stutter). Replenishment trigger fires `depositFor` (L2) when `spendable < watermark`.
**SPIKE-02:** `STATIC_FLOOR` and `P` are calibrated against simulated workload and recorded in `architecture/PHASE-1-SPIKES.md` / `BUILD/technical-arch-impl-plans/spike-results.md` — **NOT** frozen as final constants in code until SPIKE-02 passes. The test encodes the calibration scenarios; `log()` any sampling/caps so calibration coverage is honest.

**As built (reconciliations):**
- **Burn read reuses `windowSum`** (the same E4 hot-path read enforcement uses): `recent_burn = windowSum(agentId, window, now − W)` over the hold-inclusive P4 spend ZSET — one source of truth for "what has this agent spent". Default `window = '1h'` (most reactive), overridable.
- **`STATIC_FLOOR` and `P` are PARAMS, not code constants** (SPIKE-02 not frozen). `P` is applied in integer basis points (`MULTIPLIER_PRECISION = 10_000n`) so the result is exact base-unit integer math — money never passes through a JS float (covers fractional `P` like 1.5× exactly).
- **`needsReplenish(spendable, watermark) = spendable < watermark`** (strict). The replenishment trigger that calls `depositFor` is wired by the caller (M6 cron / hot path) once SPIKE-02 lands — `watermark.ts` is the pure decision seam.
- **Tests:** `watermark.test.ts` 4/4 — (1) idle agent floors at STATIC_FLOOR + needsReplenish boundary (`<` strict); (2) high-velocity agent: burn $30, P=2 → watermark $60, a $50 balance replenishes (no stutter); (3) fractional P=1.5× exact on base units; (4) an out-of-window old spend is excluded (windowed burn). Full suite 42 files/126 passed+2 skipped; typecheck+lint+build clean.

## M6.P3-B — Per-agent cooldown  — [x] DONE · sibling_quota DEFERRED

**Cooldown (DONE):** `evaluateAllocation` now enforces `cooldownSeconds` as a request-local check (alongside per_agent_max + the destination fence, BEFORE the atomic reserve, so a denied re-allocation reserves nothing and never reaches Circle). A null `secondsSinceLastAllocation` (never allocated) skips the check; the boundary is inclusive (`gap == cooldown` has elapsed → passes). New `DenyReason 'allocation_cooldown'` (spec-grounded: engine-specs:128, product-architecture:139). The caller threads `secondsSinceLastAllocation` from Provisioning's allocation history.
- **Tests:** `depositfor-cooldown.test.ts` 3/3 — within-cooldown → DENY `allocation_cooldown` + moves nothing (0 Circle calls, no reserve, no pending); at-boundary → SUBMITTED; first-ever (null gap) → SUBMITTED. Full suite 43 files/129 passed+2 skipped; typecheck+lint+build clean.

**sibling_quota (DEFERRED — Challenge / no-fork):** product-architecture-FINAL.md:141 defines `sibling_quota` as a child agent's fraction of a SHARED PARENT budget (the nested subagent-tree topology) — distinct from `per_agent_max`. The Phase-1 `AllocationPolicy` contract has **no parent/child allocation model and no quota field**, so there is nothing for the rule to act on; enforcing it would mean first introducing that nested-allocation topology + contract surface — an invention beyond the Phase-1 MVP cut and the no-fork rule. Deferred to the milestone that introduces nested allocations. The coordinated-drain case is already bounded by the enforced `total_budget` reserve (the spec's stated real bound; cooldown is necessary-not-sufficient).

## M6 Adversarial Review (Challenge Protocol)  — [x] DONE

Independent reviewer audited the M6 money-critical paths for correctness defects. Verdicts (no rubber-stamp):

- **REVISE → FIXED (real BUG-21 violation):** teardown read `isFinal` itself AND `confirmDeposit` re-read it; on a finality flip between the two reads, `confirmDeposit` returned PENDING and teardown ignored it → the deposit stayed PENDING and `float_pending != 0` (stranded). The reviewer rated the double-read "no money defect"; Challenge **upgraded** it to a BUG-21 violation. Fix: `confirmDeposit` is now the SINGLE finality authority — teardown drops its own read, falls through to CANCEL on PENDING (so every swept id ends CONFIRMED or CANCELLED, never PENDING), and counts `sweptPending` honestly (only when this call actually resolved it). Red test `teardown-sweep.test.ts` "guarantees float_pending==0 even if finality flips between reads" (RED: stranded $25 → GREEN) + an idempotent-double-teardown lock. Suite 43 files/130 passed+2 skipped.
- **PASS (documented deferral) — crash-atomicity family (3 HIGH):** (a) confirm's Lua-promote → ledger-write window, (b) depositFor's Circle-submit → record-write window leaving an orphaned `allocation_reserved`, (c) teardown's reclaim read→DECRBY non-atomicity. All are the same non-atomic Redis+network sequence whose real fix is the deferred transactional `audit_outbox`+DLQ + a Circle-op reconciler (BUG-22/38, the posture M5 already accepted). No-crash paths net correctly (reviewer-confirmed). The single per-org `allocation_reserved` counter has no per-entry TTL, so a crash-orphan needs the reconciler, not an isolated patch. **Added to deferrals.**
- **PASS (deferred to M9 + SPIKE-03) — ambiguous submit failure:** depositFor's compensate-on-throw is correct for a definitive reject; distinguishing an ambiguous timeout (Circle accepted, response lost) needs the real Circle error taxonomy (M9) and is the same untracked-credit family as SPIKE-03.
- **Concurrency during teardown:** reviewer independently surfaced the spend/confirm-racing-`float_confirmed` reclaim — exactly the question already flagged in `teardown.ts` (suspend agent / fence reclaim behind the M8 kill-switch). Unchanged; documented.
- **OK (reviewer-confirmed, no defect):** float_pending never spendable; single-winner Lua atomicity (both gate on `state=='PENDING'`); counter netting on no-crash paths; teardown ledger pair direction-flipped + balanced; cooldown pre-reserve + null/boundary; all Circle calls via the single wrapper.

**New deferrals (added):** orphaned `allocation_reserved` on a crash between Circle submit and the Redis record write → needs the Circle-op reconciler (BUG-22/38 + M9); ambiguous-submit-failure reconciliation → M9 error taxonomy / SPIKE-03.

---

## Self-Review

- **Spec coverage:** L1 ⇒ BUG-17 domain binding (policy-engine:282); L2 ⇒ depositFor P3-B (engine-specs:128) + treasury fence (signer:202); L3 ⇒ two-phase float BUG-29/39 + finality gate BUG-42; L5 ⇒ teardown sweep BUG-21; L6 ⇒ dynamic watermark NFR-05 + SPIKE-02; SPIKE-03 ⇒ L5 sweep. All four doc-04 M6 test anchors are present (`two-phase-float`, `depositfor-allocation-gated`, `teardown-sweeps-pending`, `watermark`).
- **No-fork:** `allowedDestinations` keeps its spec meaning (depositFor own-agents fence); recipient binding uses the canonical domain-binding mechanism. `destination_unverified` is a spec-named deny reason, not an invented one.
- **Type consistency:** `DomainRegistry` / `verifyDomainBinding` / `BindingResult` names are stable across L1 tasks; `EnforceDeps.domainRegistry`, `HotPathDeps.domainRegistry` match; `DepositResult`/`DepositForParams` consistent across L2/L4.
- **Fail-closed audit:** the L1 deny writes a `payment_events` row (consumed 0) exactly like the SpendPolicy deny — append-only, no money moved.

## Execution Handoff

Inline JIT execution (the M2–M5 loop): red test → run RED → implement → run GREEN → full suite + typecheck + lint + build → mark checkbox → append `log-server`. L1 executes now; L2–L6 get their bite-sized step expansion when reached (SPIKE-02/03 constants are deliberately deferred to their spikes).
