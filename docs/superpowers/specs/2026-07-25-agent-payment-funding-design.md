# Agent Payment Funding (Hybrid JIT Top-Up) — Design

**Date:** 2026-07-25
**Status:** Approved — decisions locked (see Decisions)
**Author:** Kaushal + Claude

## Decisions (locked 2026-07-25)

1. **Architecture:** Option C — Hybrid JIT top-up.
2. **Float destination:** the AGENT'S OWN delegated-key account (WCSPR), not the operator
   account. Agents with no delegated key fall back to the current behavior unchanged.
3. **Scope of first cut:** FULL loop including retire-sweep-back — funding primitive + float
   wiring + reserve compensation + retire-sweep, all with tests.
4. **No contract deploy/update** — call existing WCSPR entry points only.

## Problem

x402 service payments (order-book, risk-oracle) fail on-chain settlement with
`User error: 60001` from the Wrapped CSPR (WCSPR) CEP-18 contract. The facilitator's
`transfer_with_authorization` moves WCSPR **from the agent's delegated-key account** to
`payTo`, but agent delegated accounts hold **zero WCSPR** (and have no on-chain purse) — so
the transfer reverts. Verified on testnet: `agt_e3433…` (`1885b99…`) and `agt_3e95…`
(`11d2567…`) both return `balance: null, main_purse_uref: null`.

The existing "float" feature (`POST /v1/agents/:id/float`) does NOT fix this: it sends
**native CSPR to the operator account** (`agentFloatAddress = policy.allowedDestinations[0] ??
operatorAccountHash`) and records a ledger entry. It never puts WCSPR in the agent's own
account. The ledger layer and the on-chain payment layer are disconnected.

## Constraints (non-negotiable)

1. **NO contract deploy or update.** WCSPR (`3d80df21…`) is a third-party cspr.trade contract
   (owner `01fc3b35…`). We only CALL its existing entry points (`deposit`, `transfer`,
   `approve`, `balance_of`, `transfer_with_authorization`). Our own contracts (GuardRegistry,
   grant/revoke-delegated-key) are untouched. No wasm, no migrations to contract state.
2. **Org-wide ceiling stays authoritative.** The ceiling lives in the Redis ledger
   (`evaluateAllocation`: atomic `available = totalBudget − committed − reserved`). On-chain
   WCSPR in an agent account must never exceed what the ledger authorized. The chain must not
   become a second, unbounded spending authority.
3. **Existing infra must not break.** The current `POST /v1/agents/:id/float`,
   `/float/topup`, `/treasury/*` endpoints, the two-phase float model (`floatPending →
   floatConfirmed`, BUG-29), spend-window holds, and teardown-sweep must keep working exactly
   as today. This feature is ADDITIVE.

## Architecture: Option C — Hybrid Just-In-Time Top-Up

**Principle:** The ledger is the single source of truth for the ceiling. On-chain WCSPR in an
agent account is a *mirror* of a ledger allocation — funded just-in-time (only after the
ceiling check passes) and swept on retire. The chain never holds more than the ledger
authorized.

### Money flow

```
Operator account (native CSPR, 2345 CSPR, existing signer)
   │  (1) deposit/wrap CSPR → WCSPR   [only if operator WCSPR short]
   ▼
Operator account (WCSPR)
   │  (3) transfer WCSPR → agent account   [exact allocated amount]
   ▼
Agent delegated account  ◄── (2) native CSPR "dust" (purse existence + does NOT pay gas;
   │                              facilitator pays gas for transfer_with_authorization)
   │  x402 transfer_with_authorization (existing path, now has a balance)
   ▼
payTo (service vendor)
```

### New module: `src/engines/custody/agent-funding.ts`

Single reusable primitive, operator-signed, reusing existing submit seams
(`ContractCallBuilder` from `odra-anchorer.ts`, `createNativeCsprTransferSubmitter`):

```
fundAgentOnChain(deps, { agentAccountHash, amountMotes }) → {
  wrapTxHash?:   string   // present only if operator had to wrap
  dustTxHash?:   string   // present only if agent purse was absent
  transferTxHash: string  // the WCSPR transfer (always)
}
```

Steps, each idempotent and checked-before-acting:
1. **Ensure operator WCSPR ≥ amount.** Read operator WCSPR via `balance_of`. If short, call
   `deposit` (payable — wraps native CSPR) for the shortfall. Skip if sufficient.
2. **Ensure agent purse exists.** Read agent account. If `main_purse_uref` is null, submit a
   small fixed native CSPR dust (e.g. 2.5 CSPR) operator→agent to create the purse. Skip if
   the purse already exists.
3. **Transfer WCSPR** operator→agent account (`transfer`, operator-signed) for `amountMotes`.

No vault/delegated-key signing on this path — everything is operator-signed (operator key is
already wired via `CASPER_GUARD_SIGNER_*`). This is strictly simpler and lower-risk than
having each agent wrap its own CSPR.

### Wiring into the existing float flow (additive, not replacing)

The current `provisionHandler('depositFor')` already does the ceiling-gated ledger allocation
via `depositFor` → `evaluateAllocation`. We extend the SAME handler so that AFTER the ledger
reserve succeeds (outcome SUBMITTED), it also performs `fundAgentOnChain` for the agent's own
account. Concretely:

- The float destination becomes the **agent's own delegated account hash**, not the operator
  account. (Derived server-side from the agent's active delegated key via
  `deriveCasperAccountAddress` — never client-supplied. Falls back to current behavior if the
  agent has no delegated key, preserving old orgs.)
- The ledger reserve (org ceiling) runs FIRST and unchanged. On-chain funding runs only on a
  passing reserve, for the exact reserved amount → ceiling stays authoritative.
- On-chain funding failure AFTER a successful reserve compensates the reserve (mirrors the
  existing `redis.decrby(allocationReserved)` compensation in `depositFor` step 2) so a chain
  error never strands org budget.

### Retire sweep (close the loop)

Extend the existing teardown-sweep (`teardown.ts`, which already sweeps in-flight deposits) to
also sweep the agent's on-chain WCSPR back to the operator on retire — via an operator-initiated
`transfer_with_authorization` OR an `approve`+pull, so unused funded WCSPR returns to the pool
and the ceiling is fully reclaimed. (Detail TBD in plan; must not block retire on a chain
failure — best-effort with a recorded residual.)

## Resilience / infra-preservation analysis

| Risk | Mitigation |
| --- | --- |
| Break existing float callers | New behavior gated on the agent having a delegated key; agents without one keep the exact current path. Endpoint signature unchanged. |
| Ceiling bypass | On-chain funding is downstream of the atomic ledger reserve, for the reserved amount only. Never funds without a passing `evaluateAllocation`. |
| Partial on-chain failure (wrap ok, transfer fails) | Each step idempotent + checked-before-acting; funding is retryable; reserve compensated on terminal failure so budget isn't stranded. |
| Double-funding on retry | Steps read state first (`balance_of`, purse check) and only act on a real shortfall — a retry is a no-op if the prior attempt landed. |
| Operator key exposure | Operator key already used for GuardRegistry/treasury; no new key material or new trust surface. Same signer, same submit path. |
| WCSPR contract changes under us | We only call stable CEP-18 + WCSPR standard entry points already in production use by the facilitator. |
| Gas | Facilitator pays gas for the payment itself. Operator pays gas for wrap/transfer/dust — bounded, operator-funded. Agent dust is for purse existence, not gas. |

## Explicitly OUT of scope (YAGNI)

- Deploying or upgrading any contract.
- Per-agent CSPR→WCSPR wrapping signed by the agent's own key.
- Changing the ledger ceiling model, spend windows, or hold accounting.
- Auto-refunding on every payment; sweep is retire-time only.
- Mainnet rollout (testnet first; mainnet reuses the same code via existing network slots).

## Open questions for the plan phase

1. Dust amount for purse creation (2.5 CSPR proposed) — confirm a value that reliably creates a
   purse on testnet.
2. Sweep-on-retire exact mechanism (`transfer_with_authorization` vs `approve`+pull).
3. Whether to expose funding status (`tx hashes`, on-chain WCSPR balance) in the agent row UI,
   or keep it behind the existing float/allocation state.
