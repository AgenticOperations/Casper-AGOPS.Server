# M2 — Custody (E6) + Control (E1) Implementation Plan

> **For agentic workers:** this is the JIT bite-sized TDD plan for milestone M2 in
> `../../../technical-arch-impl-plans/04-implementation-plan.md` §3. Executed inline (TDD per
> chunk: red → green → verify → log). Steps use `- [ ]`. FINAL specs win on conflict (no-fork).

**Goal:** Stand up the Control engine (org→team→agent hierarchy, immutable versioned policies,
effective-policy compile → Redis blob + epoch) and the Custody engine (single Circle Gateway
wrapper, two-role KMS signer with the blast-radius fence, EIP-5267 domain ladder, EIP-3009
sign-only, two-phase float model, Solana designed-for seam).

**Architecture:** Control compile is a **pure** function over a root→leaf policy node list;
persistence (immutability + epoch) is Postgres + Redis. Custody signing is a provider-agnostic
`KmsSigner` (local impl for Phase-1) that enforces the role/operation fence *before* signing; the
agent never holds a key. Sign only — no broadcast until M5.

**Tech Stack:** TS strict (NodeNext ESM, `.js` relative imports) · pg · ioredis · viem
(`signTypedData`/`verifyTypedData`, `eip712Domain` read) · Vitest + Testcontainers.

**Canonical sources (cited inline in code):**
- 4 rule types + SpendPolicy combine table: `policy-engine-FINAL.md:39-45`, `:59-67`
- "child can only narrow a parent, never widen" (governs AllocationPolicy combine): `:60`
- immutable `policy_id@vN` + per-org monotonic `policy_epoch`: `:47-48`, `engine-specs-FINAL.md:76-79`
- EIP-5267 3-step ladder (eip712Domain → known-token registry → reject `unsupported_token`): `policy-engine-FINAL.md:194-199`
- EIP-3009 `TransferWithAuthorization` {from,to,value,validAfter,validBefore,nonce}; CSPRNG nonce `randomBytes(32)`: `policy-engine-FINAL.md:128-132`, `engine-specs-FINAL.md:201`
- signer-role fence (treasury=internal-allocation only; agent-float=external only, no agent→agent): `product-architecture-FINAL.md:98-99`, `engine-specs-FINAL.md:202-204`
- agent holds no key/money — financial unbypassability via key custody: `engine-specs-FINAL.md:276-277`
- two-phase float `spendable = float_confirmed − consumed − reserved − escrow_reserved`: `engine-specs-FINAL.md:178-179`

---

## File structure

```
src/
  lib/
    ids.ts                       # NEW  id minting + ag_live_ hashing (constant-time verify)
    eip712/domain.ts             # NEW  EIP-5267 ladder (resolveTokenDomain)
    eip712/eip3009.ts            # NEW  TransferWithAuthorization typed data + CSPRNG nonce
    kms/signer.ts                # NEW  KmsSigner iface + LocalKmsSigner + role/operation fence
    circle/gateway.ts            # NEW  THE single Circle Gateway wrapper (typed boundary)
    solana/transfer.ts           # NEW  SPL designed-for seam (throws phase-2 marker)
  engines/
    control/types.ts             # NEW  OrgRecord/TeamRecord/AgentRecord/PolicyVersion/PolicyNode
    control/policy-compile.ts    # NEW  pure compileEffectivePolicy (most-restrictive intersection)
    control/store.ts             # NEW  pg repo: orgs/teams/agents + immutable policy versions + epoch
    control/publish.ts           # NEW  write effective_policy blob → Redis (per-agent atomic SET)
    custody/balance.ts           # NEW  two-phase float model + computeSpendable
  redis/keyspace.ts              # EDIT add `consumed` counter (spendable subtrahend)
  db/migrations/0002_control.sql # NEW  orgs/teams/agents/policies/policy_assignments
test/
  control/effective-policy-intersection.test.ts   # pure
  control/policy-versioning.test.ts                # Testcontainers pg
  custody/eip5267-ladder.test.ts                   # mock viem client
  custody/sign-eip3009.test.ts                     # viem local account round-trip
  custody/signer-role-fence.test.ts                # fence throws
  custody/spendable.test.ts                        # computeSpendable formula
  invariant/agent-holds-no-key.test.ts             # structural invariant
  infra/migrations-apply.test.ts                   # EDIT assert 0002 + control tables
```

---

## Chunk sequence (TDD; each = red → green → verify)

### Control (E1) — first

- [ ] **C1 — IDs + API-key hashing** (`src/lib/ids.ts`)
  - Test `control/...` (folded into versioning/invariant): prefixes `org_`/`agt_`/`team_`/`policy_`,
    agent key `ag_live_`, admin `sk_live_`; `issueAgentApiKey()` → `{token, hash}`;
    `verifyApiKey(token, hash)` constant-time true, wrong token false; hash never reveals token.
  - Impl: crypto.randomBytes → base58/hex body; `hashApiKey` = sha256 hex; `verifyApiKey` =
    `timingSafeEqual`. High-entropy token ⇒ fast hash + constant-time compare (not a password KDF).

- [ ] **C2 — control schema migration** (`src/db/migrations/0002_control.sql`)
  - Test (`infra/migrations-apply.test.ts` extend): 0002 applies; tables `orgs`/`teams`/`agents`/
    `policies`/`policy_assignments` exist; `agents` has **no** `private_key` column (invariant);
    unique `(policy_id, version)`; agents.org_id FK (tenant).
  - Impl: DDL. `policies(policy_id text, version int, org_id, class 'spend'|'allocation', rules jsonb,
    created_at, PRIMARY KEY(policy_id, version))`. `orgs(id, admin_key_hash, policy_epoch int default 0)`.

- [ ] **C3 — control store: orgs/teams/agents + immutable policy versions + epoch** (`src/engines/control/store.ts`)
  - Test `control/policy-versioning.test.ts` (Testcontainers pg): create org; register agent
    (issues `agt_`/`ag_live_`); create policy → v1; "edit" → v2 (new row, same policy_id); v1 row
    unchanged + still readable; **no UPDATE path** mutates a version; each version write bumps the
    org `policy_epoch` monotonically.
  - Impl: inserts only for versions; `createPolicyVersion` selects max(version)+1; `bumpPolicyEpoch`
    `UPDATE orgs SET policy_epoch = policy_epoch + 1 ... RETURNING`.

- [ ] **C4 — effective-policy compile (pure)** (`src/engines/control/policy-compile.ts`)
  - Test `control/effective-policy-intersection.test.ts` (pure, no DB): given org/team/agent nodes,
    `compileEffectivePolicy` yields: spend `spendCap`=min, `perTransactionMax`=min,
    `serviceScope`=set-intersection, `railPermission`=set-intersection, `velocityLimitPerHour`=min;
    allocation `totalBudget`=min, `perAgentMax`=min, `cooldownSeconds`=**max**,
    `allowedDestinations`=set-intersection. Assert a child that *widens* (higher cap) does NOT raise
    the effective value (narrow-only, `:60`).
  - Impl: reduce over nodes; bigint min/max; array intersection preserving order.

- [ ] **C5 — publish effective policy → Redis** (`src/engines/control/publish.ts`)
  - Test (in versioning or a small publish test): `publishEffectivePolicy(redis, eff)` writes
    `keys.effectivePolicy(agentId)` = JSON blob carrying `policyEpoch`; single atomic `SET`
    (per-agent overwrite, not bulk DEL); re-publish replaces; blob round-trips to `EffectivePolicy`.
  - Impl: `redis.set(key, JSON.stringify(eff))`. Epoch comes from store.

### Custody (E6)

- [ ] **U1 — EIP-5267 domain ladder** (`src/lib/eip712/domain.ts`)
  - Test `custody/eip5267-ladder.test.ts`: (1) client.eip712Domain() resolves → that domain used,
    fields = {name,version,chainId,verifyingContract} from the call, **not** hardcoded; (2) call
    reverts but (chainId, token) in registry → registry name/version used; (3) neither → throws
    `unsupported_token`. Assert eip712Domain tried FIRST.
  - Impl: `resolveTokenDomain(client,{chainId,tokenAddress,registry})`: try `client.readContract`
    eip712Domain (catch revert) → registry lookup → throw. Registry seeded for Arc USDC (name/version
    asserted live elsewhere, never inlined as the only source).

- [ ] **U2 — EIP-3009 typed data + nonce** (`src/lib/eip712/eip3009.ts`)
  - Test `custody/sign-eip3009.test.ts`: `buildTransferAuthorization` → primaryType
    `TransferWithAuthorization`, types match EIP-3009 (from address, to address, value uint256,
    validAfter uint256, validBefore uint256, nonce bytes32); `generateNonce()` = 32 bytes, two calls
    differ; sign with viem local account + verifyTypedData true; function returns
    signature+authorization only (no broadcast).
  - Impl: typed-data builder + `randomBytes(32)` → `0x` hex nonce.

- [ ] **U3 — KMS signer + role/operation fence** (`src/lib/kms/signer.ts`)
  - Test `custody/signer-role-fence.test.ts`: `LocalKmsSigner` with treasury + agent-float accounts;
    `signTransfer({role:'agent-float', operation:'external-spend',...})` ok; same with
    `role:'treasury-allocation'` → throws fence error; `operation:'internal-allocation'` with
    treasury ok, with agent-float → throws.
  - Impl: fence map {agent-float→external-spend, treasury-allocation→internal-allocation}; mismatch
    throws `SignerFenceViolation` BEFORE signing. `signTransfer` delegates to viem signTypedData.

- [ ] **U4 — agent-holds-no-key invariant** (`test/invariant/agent-holds-no-key.test.ts`)
  - Test: `AgentRecord` has no key field; `SignRequest` (C-4) carries no key material; signer is
    only constructable from KMS key material (server-side), never from agent input; no exported
    function returns an agent private key. Asserts structurally + at runtime.
  - Impl: assertions only (may add a tiny `assertNoKeyMaterial` guard if useful).

- [ ] **U5 — two-phase float + spendable** (`src/engines/custody/balance.ts`, `redis/keyspace.ts` edit)
  - Test `custody/spendable.test.ts`: `computeSpendable({floatConfirmed,consumed,reserved,
    escrowReserved})` = confirmed−consumed−reserved−escrowReserved; pending excluded; bigint;
    clamps at 0 (never negative spendable).
  - Impl: pure fn; add `keys.consumed`.

- [ ] **U6 — Circle Gateway wrapper + Solana seam** (`src/lib/circle/gateway.ts`, `src/lib/solana/transfer.ts`)
  - Test (`custody/...` small): `GatewayClient` exposes getBalances/deposit/depositFor/withdraw and
    routes every call through one injected transport (the single-wrapper rule); Solana
    `signSplTransferAuthorization` throws `phase2_not_implemented` (a marked seam, not a silent stub).
  - Impl: typed wrapper over an injected `fetch`-like transport (real Circle calls land in M6);
    Solana seam interface + explicit throw.

### Close
- [ ] Run full M2 anchor set green; confirm acceptance (doc 04 §3 M2); append `log-server`; mark #19.
- [ ] Code-review pass (reviewer subagent) on the Control + Custody diffs; Challenge before adopt.

---

## Acceptance (doc 04 §3 M2)
Create org + admin; register an agent (issues `agt_`/`ag_live_`); set Allocation + Spend policy;
compile effective policy → Redis with epoch; KMS signs a test EIP-3009 payload with the domain
resolved via the ladder (asserted, not hardcoded); blast-radius fences hold (treasury cannot sign
external; agent-float cannot sign internal). Contracts satisfied: C-1, C-4 (C-11 lifecycle shape).
