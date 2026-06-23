# Casper Guard — Three Adapters Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three honest-blocked Casper seams (settlement reader, Odra anchorer, CSPR.trade executor) with real implementations, so `live_settlement` and `odra_anchor` flip from `blocked` to `ready` and a real testnet payment reconciles + anchors on-chain.

**Architecture:** Each adapter fills an existing typed seam in `reconcile-worker.ts` / `config/casper-guard.ts` — no new orchestration, no breaking the reconcile FSM. Adapter 1 is a `CasperRpcSettlementReader` that reads deploy/tx finality from a Casper node RPC, with the operator-supplied request body as a non-breaking fallback. Adapter 2 is a Rust Odra `guard-registry` contract plus a TS `OdraGuardRegistryAnchorer` that calls its `anchor_decision` entry point. Adapter 3 is a `CsprTradeExecutor` built against a typed `CsprTradeClient` interface (quote→policy→sign→submit→reconcile→anchor), with the concrete HTTP/contract call left as one clearly-marked seam (no live access yet).

**Tech Stack:** TypeScript (tsx + Fastify + pg + ioredis), `@make-software/casper-x402` (facilitator + client), `casper-js-sdk` (Transaction/RPC), Vitest (`test/casper-guard/**`), Rust + `cargo-odra` for the contract (deploy step is operator-run; toolchain not on this machine yet).

**Decisions locked (from brainstorming):**
1. Settlement: live RPC reader, request-body as fallback (non-breaking).
2. Odra: write BOTH the Rust contract and the TS anchorer.
3. CSPR.trade: typed interface now; concrete impl is a single marked seam.
4. Verification: build + live-test each on testnet (Adapter 2 deploy + Adapter 3 live test depend on infra you must supply).

**Hard external dependencies (cannot be created in code):**
- Adapter 1: a reachable Casper testnet node RPC URL (`https://node.testnet.casper.network/rpc` works) → `CASPER_GUARD_FACILITATOR_RPC_URL`.
- Adapter 2: `cargo-odra` toolchain to compile/deploy the contract; the deployed 64-char package hash → `CASPER_GUARD_ODRA_PACKAGE_HASH` + `CASPER_GUARD_ODRA_RPC_URL`. The funded testnet key already covers deploy gas.
- Adapter 3: CSPR.trade quote/submit access (not available yet) → live test deferred.

**Invariants every task must preserve:**
- The reconcile FSM in `reconcile-worker.ts` is NOT modified except through its existing `CasperGuardReconcileDeps` seam.
- Fail-closed: an unreadable settlement is `pending`/`ambiguous` (never silently `settled`); an anchor failure throws and marks the anchor `failed` (existing behavior).
- No raw key material or signature bytes are logged.
- `npx tsc --noEmit` and the existing `pnpm test:casper` suite stay green after every task.
- New env vars are optional with safe defaults so the server still boots when infra is absent (honest-blocked stays honest).

---

## File Structure

```
src/lib/casper/
  settlement-reader.ts        CREATE  CasperRpcSettlementReader (reads deploy/tx finality via RPC) + body fallback wrapper
  facilitator.ts              CREATE  thin wrapper: build FacilitatorCasperSigner + ExactCasperScheme.verify/settle
  odra-anchorer.ts            CREATE  OdraGuardRegistryAnchorer (calls anchor_decision entry point)
  cspr-trade.ts               CREATE  CsprTradeClient interface + CsprTradeExecutor + UnavailableCsprTradeClient seam

src/config/
  casper-guard.ts             MODIFY  wire settlementReader + anchorer + trade executor from env (replace blocked stubs)
  env.ts                      MODIFY  add CASPER_GUARD_FACILITATOR_RPC_URL (exists), ODRA_* (exist), CSPR_TRADE_* (exist); add CASPER_GUARD_ODRA_ENTRY_POINT, CASPER_GUARD_ODRA_ALGORITHM

src/engines/casper-guard/
  routes.ts                   MODIFY  reconcile route: prefer deps.settlementReader (live), fall back to body
  reconcile-worker.ts         UNCHANGED (seam already correct)

contracts/odra-guard-registry/ CREATE  Rust Odra contract (src/lib.rs, Cargo.toml, Odra.toml) — operator compiles/deploys

test/casper-guard/
  settlement-reader.test.ts   CREATE
  odra-anchorer.test.ts       CREATE
  cspr-trade.test.ts          CREATE
  reconcile-live-wiring.test.ts CREATE  reconcile prefers live reader, falls back to body

scripts/
  casper-settle-e2e.ts        CREATE  live testnet end-to-end: authorize → settle via facilitator → reconcile → assert SETTLED
```

---

## Chunk 1: Adapter 1 — Settlement reader (live RPC + body fallback)

### Task 1: Facilitator wrapper (verify + settle)

**Files:**
- Create: `src/lib/casper/facilitator.ts`
- Test: `test/casper-guard/facilitator.test.ts`

- [ ] **Step 1: Write the failing test** (build path + scheme construction, mocking the runtime import)

```typescript
import { describe, it, expect } from 'vitest';
import { buildCasperFacilitator } from '../../src/lib/casper/facilitator.js';

describe('buildCasperFacilitator', () => {
  it('returns undefined when no rpc url is configured (honest-blocked)', async () => {
    const fac = await buildCasperFacilitator({ pemPath: '/tmp/x.pem', algorithm: 'secp256k1', rpcUrl: '' });
    expect(fac).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd Casper-AGOPS.Server && pnpm vitest run test/casper-guard/facilitator.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `buildCasperFacilitator`

```typescript
import type { CasperNetwork } from './x402.js';

const importRuntime = (s: string): Promise<unknown> => import(/* @vite-ignore */ s) as Promise<unknown>;

const KEY_ALGORITHM = { ed25519: 1, secp256k1: 2 } as const;
export type CasperKeyAlgorithmName = keyof typeof KEY_ALGORITHM;

type FacilitatorRuntime = {
  createFacilitatorCasperSigner(pemPath: string, algorithm: number | undefined, rpcUrl: string): Promise<unknown>;
};
type FacilitatorSchemeRuntime = {
  ExactCasperScheme: new (signer: unknown) => {
    verify(payload: unknown, requirements: unknown): Promise<{ isValid: boolean; invalidReason?: string }>;
    settle(payload: unknown, requirements: unknown): Promise<{ success: boolean; transaction?: string; errorReason?: string }>;
  };
};

export interface CasperFacilitator {
  verify(input: { payload: unknown; requirements: unknown }): Promise<{ isValid: boolean; reason?: string }>;
  settle(input: { payload: unknown; requirements: unknown }): Promise<{ success: boolean; txHash?: string; reason?: string }>;
}

export async function buildCasperFacilitator(cfg: {
  pemPath: string;
  algorithm: CasperKeyAlgorithmName;
  rpcUrl: string;
}): Promise<CasperFacilitator | undefined> {
  if (cfg.rpcUrl === '' || cfg.pemPath === '') return undefined;

  const sdk = (await importRuntime('@make-software/casper-x402')) as FacilitatorRuntime;
  const signer = await sdk.createFacilitatorCasperSigner(cfg.pemPath, KEY_ALGORITHM[cfg.algorithm], cfg.rpcUrl);
  const facMod = (await importRuntime('@make-software/casper-x402/exact/facilitator')) as FacilitatorSchemeRuntime;
  const scheme = new facMod.ExactCasperScheme(signer);

  return {
    async verify({ payload, requirements }) {
      const r = await scheme.verify(payload, requirements);
      return r.isValid ? { isValid: true } : { isValid: false, reason: r.invalidReason ?? 'casper_verify_failed' };
    },
    async settle({ payload, requirements }) {
      const r = await scheme.settle(payload, requirements);
      return r.success
        ? { success: true, ...(r.transaction ? { txHash: r.transaction } : {}) }
        : { success: false, reason: r.errorReason ?? 'casper_settle_failed' };
    },
  };
}
```

> NOTE for implementer: the exact `verify`/`settle` return field names come from `@x402/core/types` `VerifyResponse`/`SettleResponse`. Confirm against `node_modules/@make-software/casper-x402/dist/esm/exact/facilitator/index.d.mts` and adjust `isValid`/`invalidReason`/`transaction`/`errorReason` if the real shape differs. The test in Step 1 does NOT exercise the live path, so it stays green regardless; live shapes are pinned in Task 7 (e2e).

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm vitest run test/casper-guard/facilitator.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/casper/facilitator.ts test/casper-guard/facilitator.test.ts
git commit -m "feat(casper): facilitator verify/settle wrapper (honest-blocked without rpc)"
```

### Task 2: CasperRpcSettlementReader (reads deploy/tx finality)

**Files:**
- Create: `src/lib/casper/settlement-reader.ts`
- Test: `test/casper-guard/settlement-reader.test.ts`

The reader implements `CasperGuardSettlementReader` (from `reconcile-worker.ts`). It reads the decision's `deployHash`/`txHash` on-chain via the node RPC (`info_get_deploy` / `info_get_transaction`). Finalized + success → `settled`; not found / not finalized → `pending`; execution error → `failed`; past `validBefore` with no settlement → `expired`.

- [ ] **Step 1: Write the failing tests** (inject a fake RPC reader so no network is needed)

```typescript
import { describe, it, expect } from 'vitest';
import { createCasperRpcSettlementReader } from '../../src/lib/casper/settlement-reader.js';
import type { CasperGuardDecisionRecord } from '../../src/engines/casper-guard/store.js';

const baseDecision = (over: Partial<CasperGuardDecisionRecord> = {}): CasperGuardDecisionRecord =>
  ({
    decisionId: 'cgd_1', orgId: 'org_1', agentId: 'agt_1', actionKind: 'x402-payment',
    network: 'casper:casper-test', resourceId: 'svc:x', amount: '100', assetKind: 'cep18',
    assetRef: 'a'.repeat(64), destination: '00' + 'b'.repeat(64), outcome: 'ALLOW',
    policyRef: 'p@v1', status: 'SIGNED', signedHeaderHash: 'sha256:deadbeef',
    txHash: null, deployHash: '0x' + 'c'.repeat(64), intent: {} as never,
    reconciliationAttempts: [], auditAnchors: [], validBefore: Math.floor(Date.now() / 1000) + 600,
    ...over,
  } as unknown as CasperGuardDecisionRecord);

describe('CasperRpcSettlementReader', () => {
  it('reports settled when the deploy is finalized with success', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: true, finalized: true, success: true, txHash: '0xtx' }),
      now: () => Math.floor(Date.now() / 1000),
    });
    const r = await reader.read(baseDecision());
    expect(r.status).toBe('settled');
    if (r.status === 'settled') expect(r.txHash).toBe('0xtx');
  });

  it('reports pending when the deploy is not yet finalized', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: true, finalized: false, success: false }),
      now: () => Math.floor(Date.now() / 1000),
    });
    expect((await reader.read(baseDecision())).status).toBe('pending');
  });

  it('reports failed when the deploy finalized with an execution error', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: true, finalized: true, success: false, error: 'Out of gas' }),
      now: () => Math.floor(Date.now() / 1000),
    });
    expect((await reader.read(baseDecision())).status).toBe('failed');
  });

  it('reports expired when no deploy is found past validBefore', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: false }),
      now: () => Math.floor(Date.now() / 1000) + 10_000,
    });
    expect((await reader.read(baseDecision({ validBefore: Math.floor(Date.now() / 1000) }))).status).toBe('expired');
  });

  it('reports pending when no deploy found but still within validBefore', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => ({ found: false }),
      now: () => Math.floor(Date.now() / 1000),
    });
    expect((await reader.read(baseDecision())).status).toBe('pending');
  });

  it('reports pending when the decision carries no deploy/tx hash yet', async () => {
    const reader = createCasperRpcSettlementReader({
      getDeploy: async () => { throw new Error('should not be called'); },
      now: () => Math.floor(Date.now() / 1000),
    });
    expect((await reader.read(baseDecision({ deployHash: null, txHash: null }))).status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm vitest run test/casper-guard/settlement-reader.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the reader against an injectable `DeployReader` port

```typescript
import type {
  CasperGuardSettlementRead,
  CasperGuardSettlementReader,
} from '../../engines/casper-guard/reconcile-worker.js';
import type { CasperGuardDecisionRecord } from '../../engines/casper-guard/store.js';

/** On-chain finality for a single deploy/tx, normalized away from RPC wire shapes. */
export interface DeployFinality {
  found: boolean;
  finalized?: boolean;
  success?: boolean;
  txHash?: string | null;
  error?: string | null;
}

/** Injectable port — the live impl (Task 3) hits the node RPC; tests inject a fake. */
export interface DeployReader {
  getDeploy(hash: string): Promise<DeployFinality>;
  now(): number;
}

export function createCasperRpcSettlementReader(port: DeployReader): CasperGuardSettlementReader {
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      const hash = decision.deployHash ?? decision.txHash;
      const source = 'casper-rpc' as const;
      // No hash to chase yet: the agent has not broadcast — pending, never settled.
      if (!hash) {
        return { status: 'pending', source, evidence: { reason: 'no_deploy_hash' }, errorCode: null };
      }

      const fin = await port.getDeploy(hash);
      if (!fin.found) {
        const expired = decision.validBefore != null && port.now() > decision.validBefore;
        return expired
          ? { status: 'expired', source, evidence: { hash, reason: 'not_found_past_valid_before' }, errorCode: 'expired' }
          : { status: 'pending', source, evidence: { hash, reason: 'not_found_yet' }, errorCode: null };
      }
      if (!fin.finalized) {
        return { status: 'pending', source, evidence: { hash, reason: 'not_finalized' }, errorCode: null };
      }
      if (fin.success) {
        return { status: 'settled', source, evidence: { hash }, txHash: fin.txHash ?? hash, deployHash: decision.deployHash ?? null };
      }
      return { status: 'failed', source, evidence: { hash, error: fin.error ?? 'execution_error' }, errorCode: 'execution_error' };
    },
  };
}
```

> NOTE: confirm `CasperGuardDecisionRecord` exposes `validBefore` (seconds). If it is named differently in `store.ts`, adjust the field read; do NOT add a new column. If `validBefore` is absent, treat "not found" always as `pending` and drop the expired branch (and its test).

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm vitest run test/casper-guard/settlement-reader.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/casper/settlement-reader.ts test/casper-guard/settlement-reader.test.ts
git commit -m "feat(casper): rpc settlement reader (settled/pending/failed/expired)"
```

### Task 3: Live DeployReader (node RPC) + body-fallback composition

**Files:**
- Modify: `src/lib/casper/settlement-reader.ts`
- Test: `test/casper-guard/settlement-reader.test.ts` (add composition test)

- [ ] **Step 1: Add the failing composition test** (live reader falls back to body when no hash / RPC blank)

```typescript
import { composeSettlementReader } from '../../src/lib/casper/settlement-reader.js';

describe('composeSettlementReader (live primary, body fallback)', () => {
  it('uses the live reader result when it is conclusive (settled/failed/expired)', async () => {
    const live = { read: async () => ({ status: 'settled' as const, source: 'casper-rpc' as const, evidence: {}, txHash: '0xtx' }) };
    const reader = composeSettlementReader(live, () => ({ status: 'pending' as const, source: 'facilitator' as const, evidence: {} }));
    expect((await reader.read({} as never)).status).toBe('settled');
  });

  it('falls back to the body settlement when the live read is pending', async () => {
    const live = { read: async () => ({ status: 'pending' as const, source: 'casper-rpc' as const, evidence: {}, errorCode: null }) };
    const reader = composeSettlementReader(live, () => ({ status: 'settled' as const, source: 'operator-wallet' as const, evidence: { manual: true }, txHash: '0xmanual' }));
    const r = await reader.read({} as never);
    expect(r.status).toBe('settled');
    if (r.status === 'settled') expect(r.source).toBe('operator-wallet');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run test/casper-guard/settlement-reader.test.ts`
Expected: FAIL (`composeSettlementReader` not exported, live RPC reader missing).

- [ ] **Step 3: Implement** the live RPC `DeployReader` and the composer

```typescript
// Append to settlement-reader.ts

const importRuntime = (s: string): Promise<unknown> => import(/* @vite-ignore */ s) as Promise<unknown>;

/** Live DeployReader backed by the Casper node JSON-RPC (info_get_deploy). */
export function createLiveDeployReader(cfg: { rpcUrl: string; now?: () => number }): DeployReader {
  return {
    now: cfg.now ?? (() => Math.floor(Date.now() / 1000)),
    async getDeploy(hash: string): Promise<DeployFinality> {
      const cleaned = hash.startsWith('0x') ? hash.slice(2) : hash;
      const res = await fetch(cfg.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info_get_deploy', params: { deploy_hash: cleaned } }),
      });
      if (!res.ok) return { found: false };
      const body = (await res.json()) as { result?: { execution_results?: unknown[] } };
      const execs = body.result?.execution_results ?? [];
      if (execs.length === 0) return { found: true, finalized: false, success: false };
      // execution_results[].result is { Success: {...} } | { Failure: { error_message } }
      const result = (execs[0] as { result?: { Success?: unknown; Failure?: { error_message?: string } } }).result ?? {};
      if ('Success' in result && result.Success) return { found: true, finalized: true, success: true, txHash: cleaned };
      const error = (result as { Failure?: { error_message?: string } }).Failure?.error_message ?? 'execution_error';
      return { found: true, finalized: true, success: false, error };
    },
  };
}

/** Live result wins when conclusive; a still-pending live read defers to the operator-supplied body. */
export function composeSettlementReader(
  live: CasperGuardSettlementReader,
  bodyFallback: () => CasperGuardSettlementRead,
): CasperGuardSettlementReader {
  return {
    async read(decision) {
      const r = await live.read(decision);
      if (r.status === 'pending' || r.status === 'ambiguous') return bodyFallback();
      return r;
    },
  };
}
```

> NOTE: `info_get_deploy` is the Casper 1.x/2.x deploy query. If the target node only exposes the 2.x `info_get_transaction`, add a second branch keyed on whether the decision has `deployHash` vs `txHash`. Keep the normalized `DeployFinality` shape so the reader + tests are unaffected.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run test/casper-guard/settlement-reader.test.ts`
Expected: PASS (all 8).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/casper/settlement-reader.ts test/casper-guard/settlement-reader.test.ts
git commit -m "feat(casper): live node-rpc deploy reader + body-fallback composer"
```

### Task 4: Wire settlement reader into the reconcile route (non-breaking)

**Files:**
- Modify: `src/config/casper-guard.ts` (build + expose a live reader factory in `CasperGuardDeps`)
- Modify: `src/engines/casper-guard/routes.ts:269-277` (prefer live reader, body fallback)
- Modify: `src/config/env.ts` (`CASPER_GUARD_SIGNER_ALGORITHM` already added; reuse it for facilitator)
- Test: `test/casper-guard/reconcile-live-wiring.test.ts`

- [ ] **Step 1: Write the failing wiring test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { loadEnv } from '../../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://x:y@localhost:5432/z', REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.example', ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

describe('buildCasperGuardDeps settlement wiring', () => {
  it('exposes a live settlement reader factory when a facilitator rpc url is set', () => {
    const env = loadEnv({ ...BASE, CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc' } as never);
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement.configured).toBe(true);
    expect(typeof deps.settlementReaderFactory).toBe('function');
  });

  it('stays honest-blocked (no factory) when no rpc url is set', () => {
    const env = loadEnv(BASE as never);
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement.configured).toBe(false);
    expect(deps.settlementReaderFactory).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run test/casper-guard/reconcile-live-wiring.test.ts`
Expected: FAIL (`settlementReaderFactory` not on deps; `configured` still false).

- [ ] **Step 3: Implement**

In `src/config/casper-guard.ts`:
- Add `settlementReaderFactory?: () => CasperGuardSettlementReader` to `CasperGuardDeps` (and to `routes.ts` `CasperGuardDeps` interface — keep the two in sync; if they are the same type, edit once).
- When `env.CASPER_GUARD_FACILITATOR_RPC_URL !== ''`: set `liveSettlement = { configured: true }` and
  `settlementReaderFactory = () => createCasperRpcSettlementReader(createLiveDeployReader({ rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL }))`.
- Otherwise leave `liveSettlement = { configured: false, reason: 'casper_facilitator_not_configured' }` and no factory.

In `src/engines/casper-guard/routes.ts` reconcile route, replace line 273:

```typescript
        settlementReader: deps?.settlementReaderFactory
          ? composeSettlementReader(deps.settlementReaderFactory(), () => settlementRead(parsed.data.settlement))
          : { read: () => Promise.resolve(settlementRead(parsed.data.settlement)) },
```

Import `composeSettlementReader` at the top of `routes.ts`.

- [ ] **Step 4: Run wiring + full casper suite**

Run: `pnpm vitest run test/casper-guard/reconcile-live-wiring.test.ts && pnpm test:casper`
Expected: PASS; existing reconcile tests still green (body path preserved when no factory).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/config/casper-guard.ts src/engines/casper-guard/routes.ts test/casper-guard/reconcile-live-wiring.test.ts
git commit -m "feat(casper): wire live settlement reader into reconcile (body fallback)"
```

### Task 5: setup-status reflects live settlement ready

**Files:**
- Modify: `src/config/casper-guard.ts` (already sets `liveSettlement.configured = true` in Task 4)
- Test: extend `test/config/casper-guard.test.ts` OR `reconcile-live-wiring.test.ts`

- [ ] **Step 1: Add assertion** that with the facilitator RPC set, the status mapping yields `live_settlement: ready` (call the same `readiness`/status builder the route uses, or assert `deps.liveSettlement.configured === true` which the route maps to ready).

- [ ] **Step 2: Run, fail (if not already covered).** Run: `pnpm vitest run test/config/casper-guard.test.ts`.

- [ ] **Step 3: Confirm** the `setup-status` route maps `liveSettlement.configured === true` → `ready`. If it currently hardcodes `configured: false`, that is fixed by Task 4. No new code expected here beyond the test.

- [ ] **Step 4: Run, pass.**

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "test(casper): live_settlement reports ready when facilitator rpc set"
```

---

## Chunk 2: Adapter 2 — Odra guard-registry (Rust contract + TS anchorer)

### Task 6: Odra guard-registry contract (Rust source)

**Files:**
- Create: `contracts/odra-guard-registry/Cargo.toml`
- Create: `contracts/odra-guard-registry/Odra.toml`
- Create: `contracts/odra-guard-registry/src/lib.rs`
- Create: `contracts/odra-guard-registry/README.md` (build + deploy steps)

This is operator-compiled (toolchain `cargo-odra` is not installed on this machine). The contract stores `decision_hash` keyed by `decision_id`, plus emits an event.

- [ ] **Step 1: Write the contract** `src/lib.rs`

```rust
use odra::prelude::*;

/// Guard registry: an append-only anchor of Casper Guard decisions.
/// Stores the decision hash (sha256:...) keyed by decision_id, with a counter for audit.
#[odra::module]
pub struct GuardRegistry {
    anchors: Mapping<String, String>, // decision_id -> decision_hash
    count: Var<u64>,
}

#[odra::module]
impl GuardRegistry {
    pub fn init(&mut self) {
        self.count.set(0);
    }

    /// Anchor a decision. Idempotent on decision_id: re-anchoring the SAME hash is a no-op;
    /// a DIFFERENT hash for an existing id reverts (an anchor is immutable).
    pub fn anchor_decision(&mut self, decision_id: String, decision_hash: String) {
        if let Some(existing) = self.anchors.get(&decision_id) {
            if existing != decision_hash {
                self.env().revert(Error::AnchorImmutable);
            }
            return;
        }
        self.anchors.set(&decision_id, decision_hash.clone());
        self.count.set(self.count.get_or_default() + 1);
        self.env().emit_event(DecisionAnchored { decision_id, decision_hash });
    }

    pub fn get_anchor(&self, decision_id: String) -> Option<String> {
        self.anchors.get(&decision_id)
    }

    pub fn total_anchored(&self) -> u64 {
        self.count.get_or_default()
    }
}

#[odra::event]
pub struct DecisionAnchored {
    pub decision_id: String,
    pub decision_hash: String,
}

#[odra::odra_error]
pub enum Error {
    AnchorImmutable = 1,
}
```

- [ ] **Step 2: Write `Cargo.toml` + `Odra.toml`** (pin Odra to a recent release; the implementer confirms the exact version against the Odra book)

```toml
# Cargo.toml
[package]
name = "odra-guard-registry"
version = "0.1.0"
edition = "2021"

[dependencies]
odra = { version = "2", default-features = false }

[lib]
crate-type = ["cdylib", "rlib"]

[[bin]]
name = "odra_guard_registry_build_contract"
path = "bin/build_contract.rs"
required-features = ["disable-allocator"]
test = false

[features]
default = []
disable-allocator = []
```

```toml
# Odra.toml
[[contracts]]
fqn = "odra_guard_registry::GuardRegistry"
```

- [ ] **Step 3: Write `README.md`** with the operator build+deploy runbook

```markdown
# Odra Guard Registry — build & deploy

Prereqs (NOT on the dev machine yet):
- Rust + wasm target: `rustup target add wasm32-unknown-unknown`
- `cargo install cargo-odra`

Build:
    cd contracts/odra-guard-registry
    cargo odra build

Deploy to testnet (uses the funded secp256k1 key already configured):
    cargo odra livenet deploy \
      --secret-key /Users/kaushalchaudhari/Desktop/casper-testnet-secret_key.pem \
      --node-address https://node.testnet.casper.network/rpc \
      --chain-name casper-test

After deploy, record the CONTRACT PACKAGE HASH (64 hex) and set in Casper-AGOPS.Server/.env:
    CASPER_GUARD_ODRA_PACKAGE_HASH=<64-char package hash>
    CASPER_GUARD_ODRA_RPC_URL=https://node.testnet.casper.network/rpc
    CASPER_GUARD_ODRA_ENTRY_POINT=anchor_decision
```

- [ ] **Step 4: Verify the contract compiles** (only if `cargo-odra` is available; otherwise mark blocked and hand the runbook to the operator)

Run: `cd contracts/odra-guard-registry && cargo odra build`
Expected: a `.wasm` artifact, OR — if toolchain absent — STOP and note "contract source complete, operator must build/deploy."

- [ ] **Step 5: Commit**

```bash
git add contracts/odra-guard-registry
git commit -m "feat(casper): odra guard-registry contract (anchor_decision, immutable)"
```

### Task 7: OdraGuardRegistryAnchorer (TS)

**Files:**
- Create: `src/lib/casper/odra-anchorer.ts`
- Test: `test/casper-guard/odra-anchorer.test.ts`

Implements `GuardRegistryAnchorer` from `reconcile-worker.ts`: builds + submits a Casper deploy calling `anchor_decision(decision_id, decision_hash)` on the configured package hash, waits for finality, returns `{ txHash }`. Submission goes through an injectable `CasperDeploySubmitter` port (live impl uses casper-js-sdk; tests inject a fake).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createOdraGuardRegistryAnchorer } from '../../src/lib/casper/odra-anchorer.js';
import type { CasperGuardDecisionRecord } from '../../src/engines/casper-guard/store.js';

const decision = { decisionId: 'cgd_9', orgId: 'org_1', agentId: 'agt_1' } as unknown as CasperGuardDecisionRecord;

describe('OdraGuardRegistryAnchorer', () => {
  it('submits anchor_decision with the id + hash and returns the tx hash', async () => {
    const submit = vi.fn().mockResolvedValue({ txHash: '0xanchored' });
    const anchorer = createOdraGuardRegistryAnchorer({
      packageHash: 'd'.repeat(64), entryPoint: 'anchor_decision',
      submitter: { submit },
    });
    const res = await anchorer.anchorDecision({ decisionId: 'cgd_9', decisionHash: 'sha256:abc', decision });
    expect(res.txHash).toBe('0xanchored');
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      packageHash: 'd'.repeat(64), entryPoint: 'anchor_decision',
      args: { decision_id: 'cgd_9', decision_hash: 'sha256:abc' },
    }));
  });

  it('throws when the submitter fails (so the anchor is marked failed upstream)', async () => {
    const anchorer = createOdraGuardRegistryAnchorer({
      packageHash: 'd'.repeat(64), entryPoint: 'anchor_decision',
      submitter: { submit: vi.fn().mockRejectedValue(new Error('node_unreachable')) },
    });
    await expect(anchorer.anchorDecision({ decisionId: 'cgd_9', decisionHash: 'sha256:abc', decision }))
      .rejects.toThrow('node_unreachable');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run test/casper-guard/odra-anchorer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import type { GuardRegistryAnchorer } from '../../engines/casper-guard/reconcile-worker.js';

/** Injectable Casper deploy submitter — live impl uses casper-js-sdk; tests inject a fake. */
export interface CasperDeploySubmitter {
  submit(input: {
    packageHash: string;
    entryPoint: string;
    args: Record<string, string>;
  }): Promise<{ txHash: string }>;
}

export function createOdraGuardRegistryAnchorer(cfg: {
  packageHash: string;
  entryPoint: string;
  submitter: CasperDeploySubmitter;
}): GuardRegistryAnchorer {
  return {
    async anchorDecision({ decisionId, decisionHash }) {
      const { txHash } = await cfg.submitter.submit({
        packageHash: cfg.packageHash,
        entryPoint: cfg.entryPoint,
        args: { decision_id: decisionId, decision_hash: decisionHash },
      });
      return { txHash };
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run test/casper-guard/odra-anchorer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/casper/odra-anchorer.ts test/casper-guard/odra-anchorer.test.ts
git commit -m "feat(casper): odra guard-registry anchorer (anchor_decision submit)"
```

### Task 8: Live CasperDeploySubmitter + wire anchorer from env

**Files:**
- Modify: `src/lib/casper/odra-anchorer.ts` (add `createLiveCasperDeploySubmitter`)
- Modify: `src/config/env.ts` (add `CASPER_GUARD_ODRA_ENTRY_POINT` default `anchor_decision`)
- Modify: `src/config/casper-guard.ts` (build anchorer when ODRA package hash + rpc are set; flip `odra.configured`)
- Test: `test/casper-guard/odra-anchorer.test.ts` (env-wiring assertion via buildCasperGuardDeps)

- [ ] **Step 1: Add env var** in `env.ts`:

```typescript
  CASPER_GUARD_ODRA_ENTRY_POINT: z.string().min(1).default('anchor_decision'),
  CASPER_GUARD_ODRA_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('secp256k1'),
```

- [ ] **Step 2: Write the failing wiring test** — `buildCasperGuardDeps` exposes a real `anchorer` when `CASPER_GUARD_ODRA_PACKAGE_HASH` + `CASPER_GUARD_ODRA_RPC_URL` are set, and `odra.configured === true`.

- [ ] **Step 3: Implement** `createLiveCasperDeploySubmitter({ rpcUrl, pemPath, algorithm, chainName })` using `casper-js-sdk` to build a `transfer`/`StoredVersionedContractByHash` call to `entryPoint` with CLValue string args, sign with the PEM key, `putDeploy`, and poll until finalized; return the deploy hash. Wire into `buildCasperGuardDeps`:

```typescript
const odraConfigured = env.CASPER_GUARD_ODRA_PACKAGE_HASH !== '' && env.CASPER_GUARD_ODRA_RPC_URL !== '';
const anchorer = odraConfigured
  ? createOdraGuardRegistryAnchorer({
      packageHash: env.CASPER_GUARD_ODRA_PACKAGE_HASH,
      entryPoint: env.CASPER_GUARD_ODRA_ENTRY_POINT,
      submitter: createLiveCasperDeploySubmitter({
        rpcUrl: env.CASPER_GUARD_ODRA_RPC_URL,
        pemPath: env.CASPER_GUARD_SIGNER_PEM_PATH,
        algorithm: env.CASPER_GUARD_ODRA_ALGORITHM,
        chainName: 'casper-test',
      }),
    })
  : undefined;
return {
  ...(signer ? { signer } : {}),
  ...(anchorer ? { anchorer } : {}),
  odra: odraConfigured ? { configured: true } : { configured: false, reason: 'odra_contract_not_bound' },
  // ...rest unchanged
};
```

> NOTE: the live submitter is the one piece that needs real casper-js-sdk deploy-building. Keep it behind the `CasperDeploySubmitter` port so all logic stays unit-tested; the live impl is exercised only by the Task 11 e2e against testnet. If casper-js-sdk's deploy API differs by version, adjust inside the submitter ONLY — the port shape and the anchorer stay fixed.

- [ ] **Step 4: Run wiring test + casper suite.** Run: `pnpm vitest run test/casper-guard/odra-anchorer.test.ts && pnpm test:casper`. Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

```bash
npx tsc --noEmit
git add src/lib/casper/odra-anchorer.ts src/config/env.ts src/config/casper-guard.ts test/casper-guard/odra-anchorer.test.ts
git commit -m "feat(casper): live odra anchorer wiring (odra_anchor -> ready when bound)"
```

---

## Chunk 3: Adapter 3 — CSPR.trade executor (interface now, impl seam)

### Task 9: CsprTradeClient interface + CsprTradeExecutor

**Files:**
- Create: `src/lib/casper/cspr-trade.ts`
- Test: `test/casper-guard/cspr-trade.test.ts`

The executor runs: `quote → policy check (slippage cap + risk allowlist, REUSING the existing trade policy) → sign/submit → return deploy/tx hash for reconcile+anchor`. The concrete quote/submit is the `CsprTradeClient` port; a `UnavailableCsprTradeClient` throws a typed error so the surface stays honest-blocked until access exists.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createCsprTradeExecutor, UnavailableCsprTradeClient, CsprTradeUnavailableError } from '../../src/lib/casper/cspr-trade.js';

const policy = { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] };

describe('CsprTradeExecutor', () => {
  it('denies a quote whose slippage exceeds the cap (no submit)', async () => {
    const submit = vi.fn();
    const exec = createCsprTradeExecutor({
      policy,
      client: { quote: async () => ({ slippageBps: 250, riskLabel: 'low', quoteId: 'q1' }), submit },
    });
    const r = await exec.execute({ intent: { pair: 'CSPR/USDC', amount: '100' } });
    expect(r.outcome).toBe('DENY');
    if (r.outcome === 'DENY') expect(r.reason).toBe('slippage_exceeds_cap');
    expect(submit).not.toHaveBeenCalled();
  });

  it('denies a quote whose risk label is not allowlisted (no submit)', async () => {
    const submit = vi.fn();
    const exec = createCsprTradeExecutor({
      policy,
      client: { quote: async () => ({ slippageBps: 10, riskLabel: 'high', quoteId: 'q1' }), submit },
    });
    const r = await exec.execute({ intent: { pair: 'CSPR/USDC', amount: '100' } });
    expect(r.outcome).toBe('DENY');
    if (r.outcome === 'DENY') expect(r.reason).toBe('risk_label_not_allowed');
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits a policy-passing quote and returns the tx hash for reconcile', async () => {
    const exec = createCsprTradeExecutor({
      policy,
      client: {
        quote: async () => ({ slippageBps: 50, riskLabel: 'low', quoteId: 'q1' }),
        submit: async () => ({ txHash: '0xswap', deployHash: '0xdep' }),
      },
    });
    const r = await exec.execute({ intent: { pair: 'CSPR/USDC', amount: '100' } });
    expect(r.outcome).toBe('ALLOW');
    if (r.outcome === 'ALLOW') { expect(r.txHash).toBe('0xswap'); expect(r.deployHash).toBe('0xdep'); }
  });

  it('UnavailableCsprTradeClient throws a typed error (honest-blocked)', async () => {
    const client = new UnavailableCsprTradeClient();
    await expect(client.quote({ pair: 'CSPR/USDC', amount: '1' })).rejects.toBeInstanceOf(CsprTradeUnavailableError);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm vitest run test/casper-guard/cspr-trade.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
export interface CsprTradeQuote { slippageBps: number; riskLabel: string; quoteId: string }
export interface CsprTradeIntent { pair: string; amount: string }

export interface CsprTradeClient {
  quote(intent: CsprTradeIntent): Promise<CsprTradeQuote>;
  submit(input: { quoteId: string }): Promise<{ txHash: string; deployHash?: string }>;
}

export class CsprTradeUnavailableError extends Error {
  constructor() { super('cspr_trade_not_configured'); this.name = 'CsprTradeUnavailableError'; }
}

/** Honest-blocked default until real CSPR.trade access exists. NEVER mocks a fill. */
export class UnavailableCsprTradeClient implements CsprTradeClient {
  quote(): Promise<CsprTradeQuote> { return Promise.reject(new CsprTradeUnavailableError()); }
  submit(): Promise<{ txHash: string }> { return Promise.reject(new CsprTradeUnavailableError()); }
}

export type CsprTradeResult =
  | { outcome: 'ALLOW'; quoteId: string; txHash: string; deployHash?: string }
  | { outcome: 'DENY'; reason: 'slippage_exceeds_cap' | 'risk_label_not_allowed' };

export function createCsprTradeExecutor(cfg: {
  policy: { maxSlippageBps: number; allowedRiskLabels: string[] };
  client: CsprTradeClient;
}) {
  return {
    async execute({ intent }: { intent: CsprTradeIntent }): Promise<CsprTradeResult> {
      const quote = await cfg.client.quote(intent);
      if (quote.slippageBps > cfg.policy.maxSlippageBps) return { outcome: 'DENY', reason: 'slippage_exceeds_cap' };
      if (!cfg.policy.allowedRiskLabels.includes(quote.riskLabel)) return { outcome: 'DENY', reason: 'risk_label_not_allowed' };
      const { txHash, deployHash } = await cfg.client.submit({ quoteId: quote.quoteId });
      return { outcome: 'ALLOW', quoteId: quote.quoteId, txHash, ...(deployHash ? { deployHash } : {}) };
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run test/casper-guard/cspr-trade.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/lib/casper/cspr-trade.ts test/casper-guard/cspr-trade.test.ts
git commit -m "feat(casper): cspr.trade executor (quote->policy->submit) with honest-blocked client"
```

### Task 10: Wire the executor (default unavailable) into deps

**Files:**
- Modify: `src/config/casper-guard.ts` (provide a `CsprTradeExecutor` built on `UnavailableCsprTradeClient` by default)
- Test: `test/casper-guard/cspr-trade.test.ts` (deps assertion)

- [ ] **Step 1:** Add a failing assertion that `buildCasperGuardDeps(env).tradeExecutor` exists and, with the default unavailable client, `execute(...)` rejects with `CsprTradeUnavailableError` (proving honest-blocked, not mocked).

- [ ] **Step 2:** Run, fail.

- [ ] **Step 3:** Implement: construct `createCsprTradeExecutor({ policy: { maxSlippageBps: env.CSPR_TRADE_MAX_SLIPPAGE_BPS, allowedRiskLabels: parseCsv(env.CSPR_TRADE_ALLOWED_RISK_LABELS) }, client: new UnavailableCsprTradeClient() })` and attach as `tradeExecutor` on deps. Leave a `// SEAM:` comment marking where a real `CsprTradeClient` is swapped in once access exists.

- [ ] **Step 4:** Run executor + casper suite. Expected: PASS.

- [ ] **Step 5:** Typecheck + commit.

```bash
npx tsc --noEmit
git add src/config/casper-guard.ts test/casper-guard/cspr-trade.test.ts
git commit -m "feat(casper): wire cspr.trade executor (honest-blocked client by default)"
```

---

## Chunk 4: Live verification (testnet)

### Task 11: Live settlement e2e script

**Files:**
- Create: `scripts/casper-settle-e2e.ts`

Drives a real testnet flow end-to-end and asserts the decision reaches `SETTLED`. Requires `CASPER_GUARD_FACILITATOR_RPC_URL` set and the funded key configured.

- [ ] **Step 1: Write the script** that:
  1. boots/uses the running backend (or imports the engine fns directly),
  2. registers a user, creates an org, provisions an agent + spend policy,
  3. calls `authorize-x402` → gets a real PAYMENT-SIGNATURE + decision_id,
  4. settles the payment via the facilitator (`facilitator.settle`) to get a real deploy hash,
  5. records the deploy hash on the decision, calls `reconcile` (live reader path),
  6. asserts the decision status is `SETTLED` and (if Odra bound) `anchored === true`.

- [ ] **Step 2: Run it against testnet**

Run: `node --env-file=.env --import tsx scripts/casper-settle-e2e.ts`
Expected: prints `SETTLED ✅` (and `ANCHORED ✅` if `CASPER_GUARD_ODRA_PACKAGE_HASH` is set). If the facilitator RPC or Odra hash is absent, the script prints which step is blocked and exits non-zero with a clear message (honest).

- [ ] **Step 3: Capture output** in the commit message / handoff notes.

- [ ] **Step 4: Commit**

```bash
git add scripts/casper-settle-e2e.ts
git commit -m "test(casper): live testnet settlement e2e (authorize->settle->reconcile->SETTLED)"
```

### Task 12: Final gate

- [ ] **Step 1:** `npx tsc --noEmit` → 0 errors.
- [ ] **Step 2:** `pnpm test:casper` → all green.
- [ ] **Step 3:** Boot backend, hit `GET /v1/casper-guard/setup-status` with an org admin key. Expected, depending on infra supplied:
  - `signer: ready` (already true),
  - `live_settlement: ready` IF `CASPER_GUARD_FACILITATOR_RPC_URL` set (else honest `blocked`),
  - `odra_anchor: ready` IF Odra package hash + rpc set AND contract deployed (else honest `blocked`),
  - `cspr_trade_policy: ready`.
- [ ] **Step 4:** Update `CASPER-MAKE-IT-REAL-PLAN.md` status table to reflect which adapters are live vs. blocked-on-infra. Commit.

---

## Self-Review

1. **Seam fidelity:** Adapters implement the EXACT interfaces already in `reconcile-worker.ts` (`CasperGuardSettlementReader`, `GuardRegistryAnchorer`) and `config/casper-guard.ts`. The reconcile FSM is untouched. ✅
2. **Non-breaking:** the live settlement reader composes WITH the existing operator-body path (`composeSettlementReader`), so current manual-reconcile tests stay green. ✅
3. **Honest-blocked preserved:** every adapter returns/throws a typed blocked state when its infra env is empty; nothing is mocked into a false `settled`/`filled`. ✅
4. **External dependencies isolated** behind injectable ports (`DeployReader`, `CasperDeploySubmitter`, `CsprTradeClient`) so all logic is unit-tested; only the thin live impls touch the network, exercised by the Task 11 e2e. ✅
5. **Toolchain reality:** Odra contract is source-complete with a runbook; build/deploy is operator-run because `cargo-odra` is not installed here. The TS anchorer does not depend on the contract being deployed to compile or unit-test. ✅
6. **CSPR.trade reality:** no live access → built against the interface with an `UnavailableCsprTradeClient`; live test deferred, surface stays honest. ✅
```
