---
created: 2026-06-21
project: casper-hacks
ecosystem: casper
tags: [casper, hackathon, backend, x402, mcp, odra, tdd]
---

# Casper Guard Backend Implementation Plan

Backlinks: [[10-Projects/Web3-Builds/Hackathons/CasperHacks/HANDOFF]] | [[10-Projects/Web3-Builds/Hackathons/CasperHacks/casper-agentic-buildathon-architecture]] | [[10-Projects/Web3-Builds/Hackathons/CasperHacks/BUILD/README]]

> **For agentic workers:** REQUIRED SUB-SKILLS: use test-driven-development, subagent-driven-development, and executing-plans. Every code slice follows red test -> run red -> implementation -> run green -> targeted verification -> broader verification before claiming done.

## Goal

Ship the complete production-grade backend for **Casper Guard**, a Casper-native AgentOps-like hackathon product built inside CasperHacks. This is not a pivot of canonical AgentOps, and this build must stay isolated from the original AgentOps project.

The backend must let a real client build the product UI and agent integration without mocks:

- Casper x402 proof/header creation and verification support.
- Bounded Casper signer provider with explicit testnet/live modes.
- Policy and hold lifecycle across Casper x402, CSPR.trade-style actions, and direct Casper actions.
- MCP-discoverable tools for agents.
- Casper RPC/CSPR.cloud reconciliation seams with fail-closed settlement state.
- Odra GuardRegistry/audit-anchor seam.
- Admin/client setup APIs for capabilities, policy, signer mode, audit export, and demo readiness.

## Locked Proof

The copied source includes `validation/spike-1-casper-x402-proof.mjs`, which passed in the accidental AgentOps workspace with `@make-software/casper-x402@1.0.0`:

- Header name: `PAYMENT-SIGNATURE`
- Payload version: `2`
- Network: `casper:casper-test`
- Asset semantics: CEP-18 contract package hash
- Local exact-scheme verification: `isValid: true`

Implementation may use local x402 proof creation/verification immediately after it is re-verified in this CasperHacks workspace. Live settlement remains credential-gated and must be represented honestly through explicit config and reconciliation status.

## Non-Negotiables

- No fake Casper rails in production code. Tests may use injected deterministic seams; production config must be explicit and fail closed.
- Do not add AWS KMS or Nitro as hackathon requirements. The requirement is a bounded Casper signer seam with clear modes and auditability.
- Keep Casper assets asset-neutral: CEP-18 hash and network metadata are first-class; do not hard-code USDC-only assumptions into Casper flows.
- CSPR.trade live integration can be a seam if public testnet access is blocked, but the backend must still model governed trade intents and reconciliation honestly.
- Odra is not custody. It anchors/verifies decisions; budget enforcement remains in Casper Guard.
- Client support is part of backend completeness: capabilities, schema, setup status, and audit export endpoints must be available.

## Touch Map

```
src/lib/casper/x402.ts                         CREATE
src/lib/casper/signer.ts                       CREATE
src/lib/casper/addresses.ts                    CREATE if needed
src/lib/casper/reconciliation.ts               CREATE
src/lib/casper/guard-registry.ts               CREATE
src/engines/casper-guard/types.ts              CREATE
src/engines/casper-guard/routes.ts             CREATE
src/engines/casper-guard/mcp.ts                CREATE
src/engines/casper-guard/policy.ts             CREATE
src/engines/casper-guard/reconcile-worker.ts   CREATE if route tests require worker seam
src/contracts/index.ts                         MODIFY: Casper rail/action/quote types
src/config/env.ts                              MODIFY: explicit Casper env
src/app.ts                                     MODIFY: register routes
src/db/migrations/0009_casper_guard.sql        CREATE
test/casper/*.test.ts                          CREATE
test/casper-guard/*.test.ts                    CREATE
test/mcp/*.test.ts                             CREATE or extend
```

## L1 - Casper x402 Library and Signer Seam

Files: `src/lib/casper/x402.ts`, `src/lib/casper/signer.ts`, `test/casper/x402.test.ts`.

- [x] RED: test that a generated Casper testnet signer creates a real `PAYMENT-SIGNATURE` header from exact Casper payment requirements and that the package facilitator verifies it.
- [x] RED: test that invalid Casper requirements are rejected before signing: wrong network, bad CEP-18 asset hash, missing token metadata, bad pay-to account, non-positive amount, or unsupported x402 version.
- [x] GREEN: implement small typed wrappers around `@make-software/casper-x402` and `@x402/core` with no app-specific policy logic.
- [x] GREEN: implement `CasperSignerProvider` modes: local testnet key material for development/tests, operator-wallet pending approval, and enterprise-custody unavailable unless configured. Unsupported modes fail closed with typed errors.
- [x] Verify: targeted test, `npm run typecheck`.

Acceptance: all Casper x402 header/proof code is isolated, typed, and usable by later enforcement routes without knowing package internals.

As-built L1: `src/lib/casper/x402.ts` creates/decodes/verifies real Casper exact x402 `PAYMENT-SIGNATURE` payloads through the installed package. `src/lib/casper/signer.ts` exposes a fail-closed `CasperSignerProvider` for local testnet, operator-wallet pending approval, and unavailable enterprise custody. `test/casper/x402.test.ts` proves happy-path package verification, pre-sign validation, malformed runtime input handling, and signer-mode typed errors. Red run failed on missing module and then malformed input TypeError; green run `npx vitest run test/casper/x402.test.ts` passed 4 tests; `npm run typecheck` passed.

## L2 - Casper Domain Model and Persistence

Files: `src/contracts/index.ts`, `src/engines/casper-guard/types.ts`, `src/db/migrations/0009_casper_guard.sql`, tests under `test/casper-guard/domain.test.ts`.

- [x] RED: test that Casper x402, CSPR.trade, and direct Casper action intents normalize into a shared `CasperGuardIntent`.
- [x] RED: test DB persistence for intents, decisions, holds, reconciliation attempts, and audit anchors.
- [x] GREEN: add typed Casper rails/action types without weakening existing Arc/Circle types.
- [x] GREEN: add migration tables with idempotency keys, decision ids, org/agent ids, hold amount, network, action kind, status, raw requirement hash, signed header hash, tx/deploy hash, and audit-anchor reference.
- [x] Verify: migration test, targeted domain tests, typecheck.

Acceptance: Casper Guard can persist every decision and later prove what was signed, denied, settled, expired, or anchored.

As-built L2: `src/engines/casper-guard/types.ts` normalizes x402-payment, CSPR.trade, and direct Casper deploy intents into a shared typed intent. `src/db/migrations/0009_casper_guard.sql` adds isolated Casper Guard decision, hold, reconciliation, and audit-anchor tables without weakening canonical `payment_events` rail constraints. `src/engines/casper-guard/store.ts` persists and reads those records. `src/contracts/index.ts` exports Casper Guard rail/action/asset edge types. Red run failed on missing modules; green run `npx vitest run test/casper-guard/domain.test.ts test/casper-guard/persistence.test.ts` passed 3 tests; `npm run typecheck` passed.

## L3 - Policy and Hold Lifecycle

Files: `src/engines/casper-guard/policy.ts`, relevant enforcement adapters, tests under `test/casper-guard/policy.test.ts`.

- [ ] RED: allowed intent places a hold before signing and returns a decision id.
- [ ] RED: denied intent never calls signer and records a denial reason.
- [ ] RED: expired or failed reconciliation releases/resolves holds exactly once and is idempotent.
- [ ] GREEN: implement hold-inclusive policy evaluation for Casper intents using existing budget and ledger patterns where possible.
- [ ] GREEN: route all signer calls behind a successful decision and persisted hold.
- [ ] Verify: targeted policy tests and typecheck.

Acceptance: no Casper payment proof or action signature can be produced without a persisted allow decision and a budget hold.

## L4 - Casper Guard HTTP APIs for Client Setup

Files: `src/engines/casper-guard/routes.ts`, `src/app.ts`, tests under `test/casper-guard/routes.test.ts`.

- [ ] RED: admin/client capabilities endpoint exposes enabled Casper networks, signer mode, required env status, x402 version, MCP URL, Odra anchor status, and unavailable-live reasons.
- [ ] RED: setup/status endpoint distinguishes ready, degraded, and blocked with concrete missing config.
- [ ] RED: authorize-x402 endpoint accepts payment requirements, applies policy, signs only on allow, and returns `PAYMENT-SIGNATURE`, decision id, hold id, and audit fields.
- [ ] RED: authorize-action endpoint handles CSPR.trade/direct Casper intents and returns allow/deny plus signature-required state.
- [ ] RED: audit export endpoint returns judge-verifiable JSON for decisions, holds, reconciliation, and anchors.
- [ ] GREEN: implement Fastify routes using existing auth and org/agent identity guards.
- [ ] Verify: route tests, typecheck, lint if touched style requires it.

Acceptance: frontend and agent clients can discover what is configured, submit real Casper intents, receive proofs or denials, and display audit evidence.

## L5 - MCP Tool Surface

Files: `src/engines/casper-guard/mcp.ts`, route registration as needed, tests under `test/mcp/casper-guard.test.ts`.

- [ ] RED: MCP tools list includes policy-check, x402-authorize, action-authorize, decision-status, and audit-export with JSON schemas.
- [ ] RED: MCP invocation uses the same service functions as HTTP routes; no duplicate policy path.
- [ ] GREEN: implement minimal JSON-RPC-compatible MCP endpoint and tool descriptors.
- [ ] Verify: MCP tests and typecheck.

Acceptance: an AI agent can discover Casper Guard through MCP and call the same guarded backend path a frontend calls.

## L6 - Reconciliation and Audit Anchoring

Files: `src/lib/casper/reconciliation.ts`, `src/lib/casper/guard-registry.ts`, `src/engines/casper-guard/reconcile-worker.ts`, tests under `test/casper-guard/reconciliation.test.ts`.

- [ ] RED: pending signed x402 decisions reconcile through injected facilitator/RPC reader and settle exactly once.
- [ ] RED: missing or ambiguous Casper read leaves status pending/degraded, not settled.
- [ ] RED: terminal failed/expired decisions release holds idempotently and retain audit evidence.
- [ ] RED: Odra GuardRegistry seam anchors decision hash and records tx/deploy hash when configured.
- [ ] GREEN: implement fail-closed reconciliation with bounded retries and typed live-read seams.
- [ ] Verify: reconciliation tests, typecheck.

Acceptance: the backend can prove the lifecycle after signing and does not pretend live settlement happened when the chain/facilitator read is absent.

## L7 - End-to-End Demo Contract

Files: focused tests under `test/casper-guard/e2e.test.ts` and any small glue required.

- [ ] RED: end-to-end test creates org/agent policy, checks capabilities, authorizes a Casper x402 requirement, persists hold, returns proof, reconciles via injected successful read, exports audit JSON.
- [ ] RED: second test proves deny path for over-budget CSPR.trade/direct action and asserts signer was not called.
- [ ] GREEN: complete missing glue.
- [ ] Verify: all Casper-focused tests, full backend test suite, typecheck, lint, build.

Acceptance: the backend is ready for the client team: real setup endpoints, real x402 proof path, denied-path correctness, reconciliation evidence, and audit export all pass without mocks in production code.

## Review Gates

- After L1: subagent code-quality review of Casper x402 wrapper/signer seam.
- After L3: subagent spec review of policy/hold lifecycle against the architecture gates.
- After L6/L7: final adversarial review before claiming backend complete.
