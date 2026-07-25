# Agent Payment Funding (Hybrid JIT Top-Up) Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fund each agent's own on-chain account with Wrapped CSPR (WCSPR), just-in-time and downstream of the org-ceiling ledger reserve, so x402 `transfer_with_authorization` settlements stop failing with `User error: 60001`.

**Architecture:** Option C (Hybrid JIT). The Redis ledger stays the single source of truth for the org ceiling (`evaluateAllocation`). After a deposit passes that atomic reserve, an operator-signed on-chain sequence (wrap CSPR→WCSPR if needed → native dust to create the agent purse → transfer WCSPR to the agent account) mirrors the reserved amount into the agent's own account. On-chain failure after reserve compensates the reserve. Retire sweeps WCSPR back to the operator. No contract deploy/update — only calls to the existing WCSPR contract (`3d80df21…`).

**Tech Stack:** TypeScript (ESM), Fastify, ioredis, Postgres (pg), casper-js-sdk v5 (Casper 2.0 Transaction API: `ContractCallBuilder`, `NativeTransferBuilder`, `CLValue`, `Key`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-agent-payment-funding-design.md`

---

## Key facts the implementer MUST know (verified against the codebase + chain)

- **WCSPR is third-party.** Package hash `3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e` (env `DEMO_CSPR_TOKEN_PACKAGE_HASH`), decimals 9, entry points confirmed on-chain: `deposit`, `transfer`, `approve`, `balance_of`, `transfer_with_authorization`. We only CALL it.
- **The existing string-only submitter is NOT reusable for token calls.** `createLiveCasperDeploySubmitter` in `src/lib/casper/odra-anchorer.ts:89-91` builds every arg with `CLValue.newCLString`. WCSPR `transfer`/`deposit` need TYPED CLValues. We add a new typed-arg client; we do NOT touch the anchorer.
- **The CLValue idiom this exact WCSPR contract uses** (verified from `@make-software/casper-x402` `buildTransferWithAuthorizationArgs`):
  - address arg → `sdk.Key.newKey("account-hash-" + rawHash)` then `sdk.CLValue.newCLKey(key)`
  - CEP-18 token amount → `sdk.CLValue.newCLUInt256(amountString)`
  - native wrap amount (`deposit`) → `U512` (`sdk.CLValue.newCLUInt512(amountString)`) — verify empirically in Task 2; WCSPR `deposit` is payable and takes the wrap amount.
- **CJS interop:** casper-js-sdk is CJS. Load via the same unwrap the codebase uses: `const mod = await import('casper-js-sdk'); const sdk = mod.default ?? mod;` (see odra-anchorer.ts:61-65 and vault-signer.ts). NEVER a bare named import.
- **Account hash format:** repo stores `00`+64hex (see `deriveCasperAccountAddress`). `AccountHash.fromString` / `Key.newKey("account-hash-"+…)` want the RAW 64 hex (strip the leading `00`). Mirror odra-anchorer.ts:136.
- **Org ceiling lives in `evaluateAllocation`** (`src/engines/enforcement/allocation-eval.ts`): atomic `available = totalBudget − committed − reserved`. On-chain funding MUST run only after this passes, for the reserved amount.
- **`depositFor` already compensates a failed submit** by `redis.decrby(keys.allocationReserved(orgId), amount)` (deposit.ts:77). We reuse that exact pattern for on-chain funding failure.
- **Operator signer config** is `CASPER_GUARD_ODRA_RPC_URL`, `CASPER_GUARD_SIGNER_PEM_INLINE`/pem path, `CASPER_GUARD_SIGNER_ALGORITHM`, `CASPER_GUARD_ODRA_CHAIN_NAME` — the same funded key the anchorer uses. Reuse via the existing config seam in `src/config/casper-guard.ts`.
- **Testnet accounts for manual verification:** operator `60854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267` (~2345 CSPR). Failing agents: `agt_e3433…` acct `1885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a`; `agt_3e95…` acct `11d25678b96b63002b8b7ce3d19f95787a7b8f4fa9c2ff5d22897848ff920a2e`.

## Resilience invariants (every task preserves these)

1. **Additive.** No existing endpoint signature changes. Agents without an active delegated key keep the CURRENT float path (operator-account destination) unchanged.
2. **Ceiling authoritative.** No WCSPR reaches an agent account without a prior passing `evaluateAllocation`, and only for the reserved amount.
3. **No stranded budget.** Any on-chain failure after a successful reserve compensates the reserve.
4. **Idempotent on retry.** Each on-chain step reads state first (`balance_of`, purse check) and acts only on a real shortfall.
5. **Injected seams + fakes in tests.** No unit test loads casper-js-sdk or hits the chain; all on-chain calls go through injected interfaces (mirrors `CasperDeploySubmitter`).

---

## Chunk 1: Typed CEP-18 token client + on-chain readers

### Task 1: CEP-18 typed contract-call submitter interface + live impl

**Files:**
- Create: `src/lib/casper/cep18-token-client.ts`
- Test: `test/casper/cep18-token-client.test.ts`

- [ ] **Step 1: Write the failing test** (interface + arg-shape contract, with an injected fake sdk-call recorder — no real chain)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildCep18TransferArgs, buildWcsprDepositArgs, type Cep18CallSubmitter } from '../../src/lib/casper/cep18-token-client.js';

describe('cep18-token-client arg builders', () => {
  it('transfer args: recipient as account-hash Key, amount as U256', () => {
    const rec = buildCep18TransferArgs({ recipientAccountHash: '001885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a', amountMotes: '3000000000' });
    expect(rec.recipient.kind).toBe('account-hash-key');
    expect(rec.recipient.rawHash).toBe('1885b992e7a0b54b3511855a39b2facef09d96b57adf36411f3a4bfe84f4001a'); // 00 stripped
    expect(rec.amount).toEqual({ clType: 'U256', value: '3000000000' });
  });

  it('deposit (wrap) args: amount as U512', () => {
    const rec = buildWcsprDepositArgs({ amountMotes: '5000000000' });
    expect(rec.amount).toEqual({ clType: 'U512', value: '5000000000' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/casper/cep18-token-client.test.ts`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Write minimal implementation** (pure arg descriptors + injectable submitter interface; the live SDK mapping is a thin adapter validated in Task 2 against the real chain)

```typescript
// A submitter that performs an operator-signed typed contract call. Live impl uses casper-js-sdk;
// tests inject a fake. Mirrors CasperDeploySubmitter but with TYPED args (Key / U256 / U512) that the
// string-only anchorer submitter cannot express.
export interface Cep18CallSubmitter {
  call(input: { packageHash: string; entryPoint: string; args: Cep18TypedArgs; paymentMotes: number }): Promise<{ txHash: string }>;
}

// Descriptor form is what tests assert; the live adapter maps these to real CLValues.
export type ClTypedArg =
  | { clType: 'U256'; value: string }
  | { clType: 'U512'; value: string }
  | { kind: 'account-hash-key'; rawHash: string };
export type Cep18TypedArgs = Record<string, ClTypedArg>;

export function buildCep18TransferArgs(p: { recipientAccountHash: string; amountMotes: string }): { recipient: ClTypedArg; amount: ClTypedArg } {
  const rawHash = p.recipientAccountHash.startsWith('00') ? p.recipientAccountHash.slice(2) : p.recipientAccountHash;
  return { recipient: { kind: 'account-hash-key', rawHash }, amount: { clType: 'U256', value: p.amountMotes } };
}

export function buildWcsprDepositArgs(p: { amountMotes: string }): { amount: ClTypedArg } {
  return { amount: { clType: 'U512', value: p.amountMotes } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/casper/cep18-token-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/casper/cep18-token-client.ts test/casper/cep18-token-client.test.ts
git commit -m "feat(casper): typed CEP-18 arg builders for WCSPR transfer/deposit"
```

### Task 2: Live Cep18CallSubmitter (casper-js-sdk adapter) + manual chain validation

**Files:**
- Modify: `src/lib/casper/cep18-token-client.ts` (add `createLiveCep18CallSubmitter`)
- Test: `test/casper/cep18-token-client.test.ts` (adapter maps descriptors → sdk CLValues via injected sdk fake)

- [ ] **Step 1: Write the failing test** — inject a fake `sdk` object capturing `CLValue.newCLKey`/`newCLUInt256`/`newCLUInt512`/`Key.newKey` calls, assert the adapter builds `ContractCallBuilder().byPackageHash().entryPoint().runtimeArgs().from().chainName().payment().build()` and signs. Mirror the structure of odra-anchorer usage.

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run test/casper/cep18-token-client.test.ts` → FAIL.

- [ ] **Step 3: Implement `createLiveCep18CallSubmitter`** — copy the SDK-load + sign + putTransaction skeleton from `createLiveCasperDeploySubmitter` (odra-anchorer.ts:74-111), but map `Cep18TypedArgs` to real CLValues:
  - `{ kind:'account-hash-key', rawHash }` → `sdk.CLValue.newCLKey(sdk.Key.newKey("account-hash-"+rawHash))`
  - `{ clType:'U256', value }` → `sdk.CLValue.newCLUInt256(value)`
  - `{ clType:'U512', value }` → `sdk.CLValue.newCLUInt512(value)`
  - Use `sdk.Args.fromMap`, `from(privateKey.publicKey)`, `payment(paymentMotes)`, CJS unwrap `mod.default ?? mod`.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: MANUAL CHAIN VALIDATION (record result in the plan).** Before trusting the adapter, run a throwaway script against testnet using the operator PEM to: (a) `deposit` wrap 1 CSPR and confirm operator WCSPR via `balance_of`; (b) `transfer` 1 WCSPR to agent acct `1885b99…` and confirm the deploy executes (no 60001). If `deposit` amount type is wrong, correct U512↔U256 and re-run. Delete the throwaway script after. **This step de-risks the exact CLType assumptions.**

- [ ] **Step 6: Commit**

```bash
git add src/lib/casper/cep18-token-client.ts test/casper/cep18-token-client.test.ts
git commit -m "feat(casper): live operator-signed CEP-18 call submitter (typed CLValues)"
```

### Task 3: On-chain balance + purse reader

**Files:**
- Create: `src/lib/casper/cep18-balance-reader.ts`
- Test: `test/casper/cep18-balance-reader.test.ts`

- [ ] **Step 1: Write the failing test** — with an injected HTTP/RPC fake, `readAccountPurseExists(accountHash)` returns false when `main_purse_uref` is null; `readWcsprBalance(packageHash, accountHash)` returns the parsed bigint (0n when absent).

- [ ] **Step 2: Run test → FAIL.**

- [ ] **Step 3: Implement** using the cspr.cloud REST reader pattern already used elsewhere (`balance-reader.ts`), reading account (`main_purse_uref`) and CEP-18 balance (dictionary/`balance_of` query). Injected fetch seam; live impl uses `CSPR_CLOUD_ACCESS_TOKEN` + `https://api.testnet.cspr.cloud`. Return `0n` on not-found rather than throwing.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Commit** `feat(casper): on-chain WCSPR balance + purse-existence reader`.

---

## Chunk 2: Agent funding orchestration

### Task 4: `fundAgentOnChain` — idempotent wrap→dust→transfer

**Files:**
- Create: `src/engines/custody/agent-funding.ts`
- Test: `test/custody/agent-funding.test.ts`

- [ ] **Step 1: Write failing tests** (all with injected fakes for the token submitter, native-transfer submitter, and readers):
  1. Happy path, operator already has WCSPR, agent purse exists → only `transfer` called; returns `{ transferTxHash }`.
  2. Operator WCSPR short → `deposit` (wrap) called for the shortfall first, then `transfer`.
  3. Agent purse absent → native dust transfer called before `transfer`.
  4. Idempotent: purse exists + operator funded → dust and wrap NOT called.
  5. `transfer` throws → error propagates (caller compensates); no partial success swallowed.

- [ ] **Step 2: Run tests → FAIL.**

- [ ] **Step 3: Implement**

```typescript
export interface AgentFundingDeps {
  tokenSubmitter: Cep18CallSubmitter;
  nativeSubmitter: NativeCsprTransferSubmitter;
  readWcsprBalance: (accountHash: string) => Promise<bigint>;
  readOperatorWcsprBalance: () => Promise<bigint>;
  readAccountPurseExists: (accountHash: string) => Promise<boolean>;
  wcsprPackageHash: string;
  operatorAccountHash: string;
  dustMotes: string; // e.g. '2500000000' (2.5 CSPR) — confirmed in Task 4 step 5
}

export interface FundAgentResult {
  transferTxHash: string;
  wrapTxHash?: string;
  dustTxHash?: string;
}

export async function fundAgentOnChain(deps: AgentFundingDeps, input: { agentAccountHash: string; amountMotes: string }): Promise<FundAgentResult> {
  const amount = BigInt(input.amountMotes);
  const result: Partial<FundAgentResult> = {};

  // 1. Ensure operator holds >= amount WCSPR; wrap the shortfall if not (idempotent: read first).
  const opBal = await deps.readOperatorWcsprBalance();
  if (opBal < amount) {
    const shortfall = (amount - opBal).toString();
    const { txHash } = await deps.tokenSubmitter.call({ packageHash: deps.wcsprPackageHash, entryPoint: 'deposit', args: buildWcsprDepositArgs({ amountMotes: shortfall }), paymentMotes: 3_000_000_000 });
    result.wrapTxHash = txHash;
  }

  // 2. Ensure agent purse exists so transfer_with_authorization has a valid `from` (idempotent).
  const purse = await deps.readAccountPurseExists(input.agentAccountHash);
  if (!purse) {
    const { txHash } = await deps.nativeSubmitter.submitTransfer({ toAccountHash: input.agentAccountHash, amountMotes: deps.dustMotes });
    result.dustTxHash = txHash;
  }

  // 3. Transfer the exact WCSPR to the agent account (operator-signed).
  const transfer = await deps.tokenSubmitter.call({
    packageHash: deps.wcsprPackageHash,
    entryPoint: 'transfer',
    args: buildCep18TransferArgs({ recipientAccountHash: input.agentAccountHash, amountMotes: input.amountMotes }),
    paymentMotes: 3_000_000_000,
  });
  result.transferTxHash = transfer.txHash;
  return result as FundAgentResult;
}
```

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Confirm dust amount** — from the Task 2 manual run, record the minimum native CSPR that reliably creates a purse on testnet; set `dustMotes` default accordingly. Note it here in the plan.

- [ ] **Step 6: Commit** `feat(custody): fundAgentOnChain idempotent wrap/dust/transfer orchestration`.

---

## Chunk 3: Ledger wiring (ceiling-gated) + route

### Task 5: Extend `depositFor` to fund on-chain after reserve, with compensation

**Files:**
- Modify: `src/engines/provisioning/deposit.ts`
- Test: `test/provisioning/deposit-onchain-funding.test.ts`

- [ ] **Step 1: Write failing tests:**
  1. Reserve DENY → `fundAgentOnChain` NOT called (ceiling gate precedes funding).
  2. Reserve ALLOW + funding succeeds → returns SUBMITTED, `float_pending` incremented (unchanged), funding tx recorded on the allocation record.
  3. Reserve ALLOW + funding THROWS → reserve compensated (`allocationReserved` decremented back), `float_pending` NOT left incremented, outcome surfaces as a funding failure (not a silent SUBMITTED).
  4. Agent has NO delegated account hash supplied → funding skipped, current behavior preserved (additive fence).

- [ ] **Step 2: Run tests → FAIL.**

- [ ] **Step 3: Implement** — extend `DepositForParams` with optional `agentAccountHash?: string` and `funding?: AgentFundingDeps`. After the existing successful reserve + submit (deposit.ts step 2), and BEFORE incrementing `float_pending`, if `agentAccountHash` and `funding` are present, call `fundAgentOnChain`; on throw, compensate `redis.decrby(keys.allocationReserved(orgId), amount)` (same as the existing submit-failure compensation) and rethrow / return a DENY-equivalent funding-failed result. Store funding tx hashes on the allocation hash. When `agentAccountHash`/`funding` absent → behave exactly as today.

- [ ] **Step 4: Run tests → PASS. Also run the full existing deposit suite** `pnpm vitest run test/provisioning/` to prove no regression.

- [ ] **Step 5: Commit** `feat(provisioning): JIT on-chain agent funding downstream of ceiling reserve`.

### Task 6: Route — derive agent's own account as float destination + wire funding deps

**Files:**
- Modify: `src/engines/control/treasury-routes.ts` (the `provisionHandler`, ~lines 86-138)
- Modify: `src/config/casper-guard.ts` and/or `src/app.ts` (build + inject `AgentFundingDeps`, WCSPR package hash from env)
- Test: `test/control/treasury-route-agent-funding.test.ts`

- [ ] **Step 1: Write failing tests:**
  1. Agent WITH active delegated key → destination is the agent's own account hash (from `deriveCasperAccountAddress(delegatedPublicKey)`), funding deps passed to `depositFor`.
  2. Agent WITHOUT delegated key → destination falls back to current operator/policy address, funding deps NOT passed (unchanged path).
  3. Endpoint response shape unchanged for existing callers (still `{ outcome, allocation_id, state }`).

- [ ] **Step 2: Run tests → FAIL.**

- [ ] **Step 3: Implement** — in `provisionHandler`, look up the agent's active delegated key (`readActiveDelegatedKey`). If present, set `agentFloatAddress = deriveCasperAccountAddress(pubkey)` AND ensure that address is in the allocation policy's `allowedDestinations` for the own-agent fence (add it to the effective allocation policy's allowed set at evaluation, OR extend the fence to accept the agent's own derived account — keep the fence intact, just make the agent's own account a valid self-destination). Build `AgentFundingDeps` once at app wiring (WCSPR package hash from `env.DEMO_CSPR_TOKEN_PACKAGE_HASH`, operator account from the network slot, live submitters + readers) and thread through. If no delegated key → current behavior verbatim.

- [ ] **Step 4: Run tests → PASS. Run `pnpm vitest run test/control/` and `test/config/`** to prove no regression.

- [ ] **Step 5: Commit** `feat(treasury): fund agent's own account on assign-float when delegated key present`.

---

## Chunk 4: Retire sweep (full-loop closure)

### Task 7: `sweepAgentWcsprOnChain` + wire into teardown

**Files:**
- Create: `src/engines/custody/agent-funding-sweep.ts`
- Modify: `src/engines/provisioning/teardown.ts` (after the confirmed-float reclaim, ~line 130)
- Test: `test/custody/agent-funding-sweep.test.ts`, `test/provisioning/teardown-onchain-sweep.test.ts`

- [ ] **Step 1: Write failing tests:**
  1. Agent has on-chain WCSPR → sweep transfers it back to operator; returns swept amount.
  2. Agent has zero WCSPR → sweep is a no-op (no tx).
  3. Sweep tx THROWS → teardown does NOT abort; records a residual/best-effort marker (mirrors the SPIKE-03 optimistic posture already documented in teardown.ts).
  4. Existing teardown ledger reclaim behavior unchanged (run existing `test/provisioning/teardown-sweep.test.ts`).

- [ ] **Step 2: Run tests → FAIL.**

- [ ] **Step 3: Implement** `sweepAgentWcsprOnChain(deps, { agentAccountHash })`: read agent WCSPR; if > 0, move it operator-ward. Because the operator cannot `transfer` FROM the agent account directly, use the same authorization mechanism the payment path uses (agent's vault key signs a `transfer_with_authorization` to the operator) OR an `approve`+operator-pull — pick the one validated in Task 2/planning; keep it best-effort. Wire into `teardownAgent` AFTER the confirmed reclaim; wrap in try/catch so a chain failure never blocks retire (consistent with the RECLAIM-FENCE / SPIKE-03 notes).

- [ ] **Step 4: Run tests → PASS. Run full `pnpm vitest run test/provisioning/`.**

- [ ] **Step 5: Commit** `feat(custody): retire-time WCSPR sweep back to operator (best-effort)`.

---

## Chunk 5: End-to-end verification (real chain)

### Task 8: Full-path proof on testnet

- [ ] **Step 1** — Build: `pnpm build`. Full suite: `pnpm vitest run`. Expected: all pass.
- [ ] **Step 2** — Deploy the branch (or run the compiled server locally against testnet) and, via the console UI, click **assign float** on a fresh agent that has an active delegated key. Confirm in the DB/logs that an allocation was reserved.
- [ ] **Step 3** — Query cspr.cloud for that agent's account: confirm `main_purse_uref` is now set and WCSPR balance equals the assigned amount.
- [ ] **Step 4** — Drive an x402 payment for that agent (`authorize_payment` → call service → `reconcile`). Expected: `reconcile` returns `settled: true, anchored: true` — NOT `60001`.
- [ ] **Step 5** — Retire the agent; confirm WCSPR sweeps back (or a residual is recorded) and the ledger reclaim still writes its teardown pair.
- [ ] **Step 6** — Record the successful reconcile decision id + tx hashes in the plan as the acceptance evidence.

---

## Acceptance criteria

- A newly-funded agent's x402 `reconcile` returns `settled: true, anchored: true` (no `User error: 60001`).
- Org ceiling is never exceeded on-chain: funding only follows a passing `evaluateAllocation`, for the reserved amount.
- All existing `test/provisioning`, `test/control`, `test/config`, `test/custody`, `test/casper` suites pass unchanged.
- Agents without a delegated key retain the exact current float behavior.
- No contract was deployed or updated.
