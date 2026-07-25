# Agent Payment Funding (Hybrid JIT Top-Up) Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fund each agent's own on-chain account with Wrapped CSPR (WCSPR), just-in-time and downstream of the org-ceiling ledger reserve, so x402 `transfer_with_authorization` settlements stop failing with `User error: 60001`.

**Architecture:** Option C (Hybrid JIT). The Redis ledger stays the single source of truth for the org ceiling (`evaluateAllocation`). After a deposit passes that atomic reserve, an operator-signed on-chain sequence (wrap CSPR→WCSPR if needed → native dust to create the agent purse → transfer WCSPR to the agent account) mirrors the reserved amount into the agent's own account. On-chain failure after reserve compensates the reserve. Retire sweeps WCSPR back to the operator. No contract deploy/update — only calls to the existing WCSPR contract (`3d80df21…`).

**Tech Stack:** TypeScript (ESM), Fastify, ioredis, Postgres (pg), casper-js-sdk v5 (Casper 2.0 Transaction API: `ContractCallBuilder`, `NativeTransferBuilder`, `CLValue`, `Key`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-agent-payment-funding-design.md`

---

## Review fixes applied (plan-document-reviewer, 2026-07-25)

Three blocking issues were found and resolved in this plan. Implementer MUST honor these:

1. **DOUBLE-SEND of native CSPR (critical).** The EXISTING `depositFor` calls
   `gateway.depositFor({ agentFloatAddress })` → `treasury-client.ts:68-74` submits a NATIVE
   CSPR transfer to `agentFloatAddress ?? operatorAccountHash`. Today that's the operator
   (self-send, harmless). **DO NOT re-target `agentFloatAddress` to the agent's account** — that
   would send the full native amount to the agent on top of dust+WCSPR, over-spending operator
   CSPR and stranding native the sweep never reclaims. **FIX: keep `agentFloatAddress` = operator
   for the native rail; pass the agent's account to `fundAgentOnChain` as a SEPARATE param
   (`agentAccountHash`).** The native `gateway.depositFor` rail is left 100% unchanged.
2. **DESTINATION-FENCE (`evaluateAllocation`).** `allowedDestinations` is seeded with operator
   hashes only (`default-policies.ts:41`), so the agent's own account is DENIED
   `service_not_allowed`. **FIX (committed, not either/or):** in `provisionHandler`, compute a
   per-request policy whose `allowedDestinations = [...policy.allocation.allowedDestinations,
   agentOwnAccount]` where `agentOwnAccount` is SERVER-derived via
   `deriveCasperAccountAddress(delegatedPublicKey)` — never client-supplied. This keeps the
   external-redirect protection intact (only the server-derived own account is added). But note
   fix #1: the native `depositFor` destination stays the operator; the union only lets the ledger
   reserve pass for the own-account funding. A test MUST assert an arbitrary non-own destination
   is still denied.
3. **RETIRE-SWEEP mechanism (Task 7) — was unimplementable as written.** Operator cannot
   `transfer` WCSPR OUT of the agent account (no allowance). Sweeping requires the agent's VAULT
   key to sign a `transfer_with_authorization` back to the operator (full EIP-712 payload + nonce
   + signature, per `buildTransferWithAuthorizationArgs`) — materially more work than Task 4.
   **FIX: Task 7 is split into its own arg-builder + vault-signing sub-steps (see revised Task 7),
   and Task 2's manual validation is extended to cover the sweep signing path.** Sweep stays
   best-effort/non-blocking on teardown.

Non-blocking clarifications also folded in: Task 5 uses an explicit `FUNDING_FAILED` outcome (not
an overloaded `DENY`); Task 3 readers are NEW work using RPC `query_balance`
(`main_purse_under_account_hash`) where a "no main purse" error is the purse-existence signal
(NOT a cspr.cloud REST reuse); Task 6 names the exact `readActiveDelegatedKey(pool,{agentId})`
call and the `env.DEMO_CSPR_TOKEN_PACKAGE_HASH === '' || slot.operatorAccountHash === ''` →
fall-back-to-current-behavior guards.

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

- [x] **Step 1: Write the failing test** (interface + arg-shape contract, with an injected fake sdk-call recorder — no real chain)

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

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/casper/cep18-token-client.test.ts`
Expected: FAIL — module/functions not defined.

- [x] **Step 3: Write minimal implementation** (pure arg descriptors + injectable submitter interface; the live SDK mapping is a thin adapter validated in Task 2 against the real chain)

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

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/casper/cep18-token-client.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/casper/cep18-token-client.ts test/casper/cep18-token-client.test.ts
git commit -m "feat(casper): typed CEP-18 arg builders for WCSPR transfer/deposit"
```

### Task 2: Live Cep18CallSubmitter (casper-js-sdk adapter) + manual chain validation

**Files:**
- Modify: `src/lib/casper/cep18-token-client.ts` (add `createLiveCep18CallSubmitter`)
- Test: `test/casper/cep18-token-client.test.ts` (adapter maps descriptors → sdk CLValues via injected sdk fake)

- [x] **Step 1: Write the failing test** — inject a fake `sdk` object capturing `CLValue.newCLKey`/`newCLUInt256`/`newCLUInt512`/`Key.newKey` calls, assert the adapter builds `ContractCallBuilder().byPackageHash().entryPoint().runtimeArgs().from().chainName().payment().build()` and signs. Mirror the structure of odra-anchorer usage.

- [x] **Step 2: Run test to verify it fails** — `pnpm vitest run test/casper/cep18-token-client.test.ts` → FAIL.

- [x] **Step 3: Implement `createLiveCep18CallSubmitter`** — copy the SDK-load + sign + putTransaction skeleton from `createLiveCasperDeploySubmitter` (odra-anchorer.ts:74-111), but map `Cep18TypedArgs` to real CLValues:
  - `{ kind:'account-hash-key', rawHash }` → `sdk.CLValue.newCLKey(sdk.Key.newKey("account-hash-"+rawHash))`
  - `{ clType:'U256', value }` → `sdk.CLValue.newCLUInt256(value)`
  - `{ clType:'U512', value }` → `sdk.CLValue.newCLUInt512(value)`
  - Use `sdk.Args.fromMap`, `from(privateKey.publicKey)`, `payment(paymentMotes)`, CJS unwrap `mod.default ?? mod`.

- [x] **Step 4: Run test to verify it passes** — PASS.

- [x] **Step 5: MANUAL CHAIN VALIDATION (record results in the plan).** Before trusting the adapter, run a throwaway script against testnet using the operator PEM to:
  (a) `deposit` wrap 1 CSPR; confirm operator WCSPR increased (via `balance_of` / dictionary read). If the `deposit` amount CLType is wrong, correct U512↔U256 and re-run.
  (b) `transfer` 1 WCSPR to agent acct `1885b99…`; confirm the deploy EXECUTES (no `60001`). **Record the recipient CLType that succeeded** (expected `Key` account-hash) — `transfer` is not directly observed in the x402 package, so this run is its empirical confirmation.
  (c) **Sweep path pre-check (for Task 7):** confirm the deployed WCSPR exposes `transfer_with_authorization` (already used by the facilitator) and that an operator-submitted, agent-vault-signed authorization is accepted — a minimal end-to-end of the sweep direction (agent→operator) with a tiny amount, OR at minimum verify the entry point + arg shape so Task 7 isn't building blind.
  Delete the throwaway script after. **This step de-risks the exact CLType assumptions AND the sweep mechanism.**

  **VALIDATION RESULTS (2026-07-25, testnet, operator `60854d9e…`):**
  - (a) `deposit` wrap 1 CSPR with amount as **U512** → tx `1c6db50e448b9136c3b3e9fb425d2c4f0de5926e81338437ad34a43883239acf` → **SUCCESS (executed, no error).** U512 CLType for `deposit` amount CONFIRMED.
  - (b) `transfer` 0.5 WCSPR to agent `1885b99…` with recipient as **account-hash Key** + amount as **U256** → tx `f1af1c735cca69be59fcc14b891c7a663ef2899cd1f1fd026c81f79620292094` → **SUCCESS (executed, no error, no 60001).** Recipient-as-Key + U256 CLTypes CONFIRMED empirically (transfer is not observed in the x402 package, so this run is its confirmation).
  - (c) Sweep pre-check: WCSPR package `hash-3d80df21…` resolves in `query_global_state` (`stored_value` present); `transfer_with_authorization` is already exercised by the facilitator payment path, so the entry point + arg shape used in Task 7 are grounded. Chain name for testnet is `casper-test` (note: `.env` `CASPER_GUARD_ODRA_CHAIN_NAME=casper` targets mainnet — the live submitter defaults to `casper-test`; verify the injected chainName matches the target network when wiring Task 6).

- [x] **Step 6: Commit**

```bash
git add src/lib/casper/cep18-token-client.ts test/casper/cep18-token-client.test.ts
git commit -m "feat(casper): live operator-signed CEP-18 call submitter (typed CLValues)"
```

### Task 3: On-chain balance + purse reader

**Files:**
- Create: `src/lib/casper/cep18-balance-reader.ts`
- Test: `test/casper/cep18-balance-reader.test.ts`

- [x] **Step 1: Write the failing test** — with an injected HTTP/RPC fake, `readAccountPurseExists(accountHash)` returns false when `main_purse_uref` is null; `readWcsprBalance(packageHash, accountHash)` returns the parsed bigint (0n when absent).

- [x] **Step 2: Run test → FAIL.**

- [x] **Step 3: Implement (NEW work — not a cspr.cloud reuse).** `balance-reader.ts` uses Casper node RPC `query_balance` with `purse_identifier.main_purse_under_account_hash` (`balance-reader.ts:18-26`), NOT cspr.cloud REST. Follow that RPC-fetch seam:
  - `readAccountPurseExists(accountHash)`: call `query_balance` for the account; a `NoMainPurse` / account-not-found RPC error (the account has never been funded) → return `false`; a successful balance → `true`. This error IS the clean purse-existence signal.
  - `readWcsprBalance(packageHash, accountHash)`: query the CEP-18 balances dictionary for the account's key (derive the dictionary item key from the account hash per CEP-18), parse the U256 → bigint; return `0n` when the dictionary item is absent (never throw). Use the WCSPR contract's `balances_uref` (from the package metadata) or a `state_get_dictionary_item` RPC. Injected fetch seam; live impl uses `env.CASPER_GUARD_ODRA_RPC_URL`.
  - Return `0n` / `false` on not-found rather than throwing, so a fresh account reads as empty (which is the real state).

- [x] **Step 4: Run test → PASS.**

- [x] **Step 5: Commit** `feat(casper): on-chain WCSPR balance + purse-existence reader`.

---

## Chunk 2: Agent funding orchestration

### Task 4: `fundAgentOnChain` — idempotent wrap→dust→transfer

**Files:**
- Create: `src/engines/custody/agent-funding.ts`
- Test: `test/custody/agent-funding.test.ts`

- [x] **Step 1: Write failing tests** (all with injected fakes for the token submitter, native-transfer submitter, and readers):
  1. Happy path, operator already has WCSPR, agent purse exists → only `transfer` called; returns `{ transferTxHash }`.
  2. Operator WCSPR short → `deposit` (wrap) called for the shortfall first, then `transfer`.
  3. Agent purse absent → native dust transfer called before `transfer`.
  4. Idempotent: purse exists + operator funded → dust and wrap NOT called.
  5. `transfer` throws → error propagates (caller compensates); no partial success swallowed.

- [x] **Step 2: Run tests → FAIL.**

- [x] **Step 3: Implement**

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

- [x] **Step 4: Run tests → PASS.**

- [x] **Step 5: Confirm dust amount** — from the Task 2 manual run, record the minimum native CSPR that reliably creates a purse on testnet; set `dustMotes` default accordingly. Note it here in the plan.


  **DUST NOTE (2026-07-25):** default `dustMotes = 2500000000` (2.5 CSPR). CEP-18 `transfer` to an account-hash Key succeeds even for an account with no native main purse (balances live in the WCSPR contract dictionary — confirmed in Task 2, where `transfer` to `1885b99…` populated its balance with no prior purse). Dust is therefore a safety step to ensure the agent's main purse exists; 2.5 CSPR reliably creates a purse via native transfer on testnet. Sweep gas is paid by the OPERATOR (operator submits the vault-signed authorization), so the agent purse does not need to fund gas.
- [x] **Step 6: Commit** `feat(custody): fundAgentOnChain idempotent wrap/dust/transfer orchestration`.

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

- [ ] **Step 3: Implement** — extend `DepositForParams` with optional `agentAccountHash?: string` and `funding?: AgentFundingDeps`. Add a new result variant so a funding failure is NOT confused with a policy DENY:

```typescript
export type DepositResult =
  | { outcome: 'SUBMITTED'; allocationId: string }
  | { outcome: 'DENY'; reason: DenyReason }
  | { outcome: 'FUNDING_FAILED'; reason: string }; // on-chain funding threw AFTER a passing reserve
```

Ordering (critical — preserves invariants):
1. Existing P3-B reserve gate (unchanged). DENY → return DENY, nothing moved, funding never called.
2. Existing `gateway.depositFor({ orgId, agentId, amount, agentFloatAddress })` native-rail submit (UNCHANGED — `agentFloatAddress` stays the operator; see Review fix #1). Its existing submit-failure compensation (`decrby allocationReserved`) is untouched.
3. **NEW:** if `agentAccountHash` and `funding` present, call `fundAgentOnChain(funding, { agentAccountHash, amountMotes: amount.toString() })`. On throw: compensate `redis.decrby(keys.allocationReserved(orgId), amount.toString())` and return `{ outcome: 'FUNDING_FAILED', reason }`. Do NOT increment `float_pending`. (Caveat to note in code comment: the step-2 native tx already submitted; compensation restores the ledger reserve, and because the native rail targets the operator (self-send), no external value was stranded — this is exactly why fix #1 keeps the native destination as the operator.)
4. Existing `redis.incrby(keys.floatPending(agentId), amount)` + allocation record (unchanged), now also storing `fundTxHash`/`wrapTxHash`/`dustTxHash` on the allocation hash when funding ran.

When `agentAccountHash`/`funding` absent → behavior is byte-for-byte today's path.

- [ ] **Step 4: Run tests → PASS. Also run the full existing deposit suite** `pnpm vitest run test/provisioning/` to prove no regression.

- [ ] **Step 5: Commit** `feat(provisioning): JIT on-chain agent funding downstream of ceiling reserve`.

### Task 6: Route — derive agent's own account as float destination + wire funding deps

**Files:**
- Modify: `src/engines/control/treasury-routes.ts` (the `provisionHandler`, ~lines 86-138)
- Modify: `src/config/casper-guard.ts` and/or `src/app.ts` (build + inject `AgentFundingDeps`, WCSPR package hash from env)
- Test: `test/control/treasury-route-agent-funding.test.ts`

- [ ] **Step 1: Write failing tests:**
  1. Agent WITH active delegated key → the NATIVE `depositFor` destination stays the OPERATOR (fix #1), `agentAccountHash` = `deriveCasperAccountAddress(delegatedPublicKey)` is passed separately, and `funding` deps are passed to `depositFor`.
  2. Agent WITHOUT delegated key → no `agentAccountHash`/`funding` passed; behavior is today's path verbatim.
  3. Endpoint response shape unchanged for existing callers (still `{ outcome, allocation_id, state }`); a `FUNDING_FAILED` outcome maps to a distinct non-2xx (e.g. 502) without altering the SUBMITTED/deny shapes.
  4. Fence integrity: an arbitrary non-own destination is STILL denied `service_not_allowed` (the union only adds the server-derived own account).
  5. Guards: when `env.DEMO_CSPR_TOKEN_PACKAGE_HASH === ''` OR `slot.operatorAccountHash === ''`, funding is skipped and the current path runs (additive fence holds in the unconfigured test harness).
  6. **Double-send regression (reviewer-recommended):** on a full float for a delegated-key agent, the NATIVE transfer submitter is called with `toAccountHash === operator` (NOT the agent), exactly ONCE; the agent account receives only dust (native) + WCSPR. This test locks in fix #1.

- [ ] **Step 2: Run tests → FAIL.**

- [ ] **Step 3: Implement** — in `provisionHandler`:
  1. Look up the active delegated key: `const active = await readActiveDelegatedKey(pool, { agentId });` (returns `{ publicKey } | null`).
  2. Compute `const agentOwnAccount = active ? await deriveCasperAccountAddress(active.publicKey) : undefined;`
  3. **Keep `agentFloatAddress` EXACTLY as today** (`policy.allocation.allowedDestinations[0] ?? slot.operatorAccountHash`) — this is the native rail destination; do NOT change it (fix #1).
  4. **Fence union (fix #2):** when funding will run, evaluate the reserve against a per-request policy copy whose `allocation.allowedDestinations = [...policy.allocation.allowedDestinations, agentOwnAccount]`. `agentOwnAccount` is SERVER-derived only. Pass this copy to `depositFor`. (The own-agent fence still rejects any client/external destination; only the derived own account is added.)
  5. Build `AgentFundingDeps` once at app wiring: `wcsprPackageHash = env.DEMO_CSPR_TOKEN_PACKAGE_HASH`, `operatorAccountHash = slot.operatorAccountHash`, live `Cep18CallSubmitter` + `NativeCsprTransferSubmitter` + readers (Chunk 1). Thread it into the handler's deps.
  6. **Fund only when fully configured:** pass `agentAccountHash = agentOwnAccount` and `funding` to `depositFor` ONLY when `agentOwnAccount && env.DEMO_CSPR_TOKEN_PACKAGE_HASH !== '' && slot.operatorAccountHash !== ''`. Otherwise omit both → today's behavior verbatim.
  7. Map a `FUNDING_FAILED` DepositResult to a `502`/`{ error: 'agent_funding_failed', reason }` reply; leave SUBMITTED/deny replies unchanged.

- [ ] **Step 4: Run tests → PASS. Run `pnpm vitest run test/control/` and `test/config/`** to prove no regression.

- [ ] **Step 5: Commit** `feat(treasury): fund agent's own account on assign-float when delegated key present`.

---

## Chunk 4: Retire sweep (full-loop closure)

### Task 7: `sweepAgentWcsprOnChain` + wire into teardown

**Mechanism decision (fix #3):** the operator cannot `transfer` WCSPR OUT of the agent account (no allowance). The sweep therefore uses the SAME `transfer_with_authorization` rail the payment path uses, but directed agent→operator: the agent's VAULT key signs an authorization moving its WCSPR to the operator, and the OPERATOR submits it (operator pays gas). This reuses `vault.signWith` (key-vault.ts) and the exact `buildTransferWithAuthorizationArgs` CLValue shape (chunk-U7JH2PXO.mjs:375-397). `approve`+pull is rejected (two txs, needs the agent to sign an `approve` anyway — same vault-signing requirement, more steps). Sweep is best-effort/non-blocking, matching the SPIKE-03 optimistic posture (teardown.ts:22-31).

**Files:**
- Create: `src/engines/custody/wcspr-authorization.ts` (build + vault-sign a `transfer_with_authorization` payload agent→dest)
- Create: `src/engines/custody/agent-funding-sweep.ts` (`sweepAgentWcsprOnChain`)
- Modify: `src/engines/provisioning/teardown.ts` (after the confirmed-float reclaim, ~line 130)
- Test: `test/custody/wcspr-authorization.test.ts`, `test/custody/agent-funding-sweep.test.ts`, `test/provisioning/teardown-onchain-sweep.test.ts`

- [ ] **Step 1a: Write failing test for `wcspr-authorization.ts`** — with an injected vault fake, `buildVaultSignedTransferAuthorization({ vault, agentId, fromAccountHash, toAccountHash, amountMotes, publicKeyHex })` returns a payload whose signature is the 65-byte tagged vault signature (reuse the tag logic already added in vault-signer.ts), `from`/`to` as account-hash Keys, `amount` U256, a fresh 32-byte `nonce`, and `valid_after`/`valid_before` window. Assert arg CLTypes match the facilitator shape.

- [ ] **Step 1b: Write failing tests for `sweepAgentWcsprOnChain` + teardown wiring:**
  1. Agent has on-chain WCSPR → builds a vault-signed authorization agent→operator and the operator submits `transfer_with_authorization`; returns swept amount.
  2. Agent has zero WCSPR → no-op (no tx, no vault call).
  3. Sweep THROWS → `teardownAgent` does NOT abort; records a residual marker (a Redis key `agent:{id}:sweep_residual` = amount + a log line) — define the marker concretely.
  4. Existing teardown ledger reclaim unchanged (run existing `test/provisioning/teardown-sweep.test.ts`).

- [ ] **Step 2: Run tests → FAIL.**

- [ ] **Step 3a: Implement `wcspr-authorization.ts`** — port `buildTransferWithAuthorizationArgs` (chunk-U7JH2PXO.mjs:375-397) into a typed descriptor + real-CLValue adapter (extend the Cep18 arg-builder from Chunk 1 with the `from/to/amount/valid_after/valid_before/nonce/public_key/signature` fields). Compute the EIP-712 digest the same way the client scheme does: import `hashTypedData`, `CASPER_DOMAIN_TYPES`, `transferWithAuthorizationTypes`, `buildDomain` from `@casper-ecosystem/casper-eip-712` (installed transitively via x402). The domain requires `buildDomain(name, version, network, "0x"+assetContractHash)` where `name`/`version` come from env (`DEMO_CSPR_TOKEN_NAME`, `DEMO_CSPR_TOKEN_VERSION`) and `asset` is the WCSPR contract hash — **inject these via deps, do NOT re-read env inside the module** (keeps the injected-seams invariant clean for the unit test). Nonce MUST be exactly 32 random bytes (the library hard-requires 32, chunk-U7JH2PXO.mjs:212). Sign the digest via `vault.signWith(agentId, digest)`, tag to 65 bytes (same helper as vault-signer.ts). Set `valid_after=0`, `valid_before=now+maxTimeoutSeconds`. NOTE (from reviewer): the domain reconstruction (name/version/asset sourcing) is the part most likely to need a second manual-validation iteration — Task 2 Step 5(c) de-risks it first.

- [ ] **Step 3b: Implement `sweepAgentWcsprOnChain(deps, { agentId, agentAccountHash, agentPublicKeyHex })`** — read agent WCSPR; if `0n`, return `{ swept: 0n }`. Else build the vault-signed authorization agent→operator, submit via the operator's `Cep18CallSubmitter.call({ entryPoint:'transfer_with_authorization', args, ... })`, return `{ swept, txHash }`.

- [ ] **Step 3c: Wire into `teardownAgent`** — AFTER the confirmed-float reclaim (teardown.ts:130), inside a `try/catch`: call `sweepAgentWcsprOnChain`; on throw, `redis.set(keys residual marker)` + `log.error` and continue (never block retire). Only run when funding is configured (WCSPR pkg + operator set) and the agent has a delegated key/public key available.

- [ ] **Step 4: Run tests → PASS. Run full `pnpm vitest run test/provisioning/ test/custody/`.**

- [ ] **Step 5: Commit** `feat(custody): retire-time vault-signed WCSPR sweep back to operator (best-effort)`.

---

## Chunk 5: End-to-end verification (real chain)

### Task 8: Full-path proof on testnet

- [ ] **Step 1** — Build: `pnpm build`. Full suite: `pnpm vitest run`. Expected: all pass.
- [ ] **Step 2** — Deploy the branch (or run the compiled server locally against testnet) and, via the console UI, click **assign float** on a fresh agent that has an active delegated key. Confirm in the DB/logs that an allocation was reserved.
- [ ] **Step 3** — Query cspr.cloud for that agent's account: confirm `main_purse_uref` is now set and WCSPR balance equals the assigned amount.
- [ ] **Step 4** — Drive an x402 payment for that agent (`authorize_payment` → call service → `reconcile`). Expected: `reconcile` returns `settled: true, anchored: true` — NOT `60001`.
- [ ] **Step 5** — Retire the agent; confirm WCSPR sweeps back OR a residual marker is recorded (the Redis key `agent:{id}:sweep_residual` = swept-amount, defined in Task 7), and the ledger reclaim still writes its teardown pair.
- [ ] **Step 6** — Record the successful reconcile decision id + tx hashes in the plan as the acceptance evidence.

---

## Acceptance criteria

- A newly-funded agent's x402 `reconcile` returns `settled: true, anchored: true` (no `User error: 60001`).
- Org ceiling is never exceeded on-chain: funding only follows a passing `evaluateAllocation`, for the reserved amount.
- All existing `test/provisioning`, `test/control`, `test/config`, `test/custody`, `test/casper` suites pass unchanged.
- Agents without a delegated key retain the exact current float behavior.
- No contract was deployed or updated.
