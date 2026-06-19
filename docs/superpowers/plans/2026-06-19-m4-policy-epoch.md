# M4 — SPIKE-05: policy-epoch propagation + inline recompile · gate NFR-03

> JIT bite-sized TDD plan for milestone M4 in `../../../technical-arch-impl-plans/04-implementation-plan.md` §3 (M4) + §4 (SPIKE-05).
> Executed inline (TDD per chunk: red → green → verify → log). FINAL specs win on conflict (no-fork).

**Goal:** Make the slow per-agent policy propagation safe on the hot path. Build the P3-A
**stale-epoch guard**: a monotonic per-org epoch counter in Redis (the instant edit signal), and a
resolver that rejects an `effective_policy` blob whose epoch predates the org's current epoch and
performs a synchronous inline recompile in `< 500ms` before deciding. Then run SPIKE-05: measure
the sequential-rewrite propagation tail (N = 100 / 1k / 5k) and the inline-recompile latency, and
record both in `spike-results.md`.

**Architecture:** An edit bumps Postgres `orgs.policy_epoch` (source of truth, already built in M2)
and mirrors it to a Redis counter `org:{id}:policy_epoch` (monotonic, O(1) — the instant signal).
Rewriting every agent's blob with the new epoch is the slow tail. During that tail, an authorize
that loads a not-yet-rewritten blob sees `blob.policyEpoch < current`; the guard catches it,
recompiles that one agent inline against Postgres (the source of truth), republishes, and
self-heals the counter. The bulk per-agent invalidation loop is NOT in M4 — only the guard that
makes propagation lag safe. NFR-03 is satisfied by construction here.

**Tech Stack:** ioredis + Lua (`defineCommand`/EVALSHA) · pg · Vitest + Testcontainers.

## Canonical behaviors (cited; adopt verbatim)
- Monotonic `policy_epoch` per org on any ancestor edit; P3-A rejects a cache entry whose epoch
  predates the org's current epoch and recompiles inline for that agent before deciding:
  `PHASE-1-NFR-CHECKLIST.md:35-40` (NFR-03).
- Measure (a) sequential rewrite of N effective_policy keys (N = 100 / 1k / 5k) = the worst-case
  stale window the guard must cover; (b) single-agent inline recompile stays within the P3-A
  hot-path budget (`< 500ms` total request): `PHASE-1-SPIKES.md:49-55` (SPIKE-05).
- Effective policy blob is a single per-agent `SET` (atomic overwrite, never bulk-delete); the
  epoch in the blob is the staleness guard: `publish.ts:9-17` (M2), C-1.

## Implementation choices where the spec is SILENT (flagged, not spec claims)
- **Monotonic counter via Lua `set-if-greater`.** `createPolicyVersion` serializes per-org epoch
  assignment with `FOR UPDATE`, so Postgres epochs are monotonic; but the Redis mirror write
  happens after COMMIT, outside that lock, so two committed edits could race the Redis writes
  out of order. A `set-if-greater` Lua guarantees the counter never moves backward — a
  money-correctness invariant (a counter that regressed would let a stale blob pass the guard).
- **`current === null` forces a recompile (fail toward freshness).** Before an org's first edit
  propagates, the counter may be unset while a blob published at M2 compile exists. Not knowing
  the current epoch, the guard recompiles (Postgres is the truth) and self-heals the counter. This
  is a one-time cold-start cost per org, not per request; the alternative (trusting a blob when the
  current epoch is unknown) risks staleness.
- **The guard self-heals the counter** after an inline recompile (`bumpOrgEpoch` to the recompiled
  epoch, monotonic so harmless), so a forgotten edit-time bump cannot strand the org in a
  recompile-every-request state.
- **`recompileAgentPolicy` is NOT modified** (it is M2's, and M2 tests assert its blob output) —
  the counter-bump responsibility lives entirely in M4's `epoch.ts` and the guard.

## File structure
```
src/redis/lua/epoch-bump.lua            # NEW monotonic set-if-greater on org:{id}:policy_epoch
src/redis/lua/load.ts                   # EDIT export EPOCH_BUMP_LUA
src/engines/control/epoch.ts            # NEW registerEpochScript + bumpOrgEpoch + readOrgEpoch
src/engines/enforcement/policy-epoch-guard.ts  # NEW resolveEffectivePolicy (P3-A stale-epoch guard)
test/control/org-epoch-monotonic.test.ts       # NEW Testcontainers redis (L1)
test/enforcement/policy-epoch-guard.test.ts     # NEW anchor: stale→recompile→fresh <500ms (L2)
test/spikes/policy-epoch-propagation.test.ts    # NEW SPIKE-05 bench: tail N + recompile p50/p99 (L3)
```
`scripts/copy-lua.mjs` already globs `src/redis/lua/*.lua` → no change (picks up `epoch-bump.lua`).

## Chunk sequence (TDD)
- [x] **L1 — epoch-bump.lua + bumpOrgEpoch / readOrgEpoch (monotonic).** Lua: `GET` the counter;
  if absent or `tonumber(ARGV[1]) > tonumber(cur)` then `SET` + return 1, else return 0.
  `registerEpochScript(redis)` (WeakSet-guarded `defineCommand`, numberOfKeys 1).
  `bumpOrgEpoch(redis, orgId, epoch)` → `true` if it advanced the counter. `readOrgEpoch(redis,
  orgId)` → `number | null`. Test (Testcontainers redis): bump 1 → true (counter 1); re-bump 1 →
  false (no advance); bump 3 → true (counter 3); bump 2 → false, counter stays 3 (never backward);
  `readOrgEpoch` returns 3; unknown org → null.
- [x] **L2 — resolveEffectivePolicy guard (anchor).** `resolveEffectivePolicy(pool, redis,
  { agentId, orgId })` → `{ policy: EffectivePolicy; recompiled: boolean }`. Read blob
  (`readEffectivePolicy`) + counter (`readOrgEpoch`); if blob present AND current non-null AND
  `blob.policyEpoch >= current` → `{ policy: blob, recompiled: false }`; else inline
  `recompileAgentPolicy`, `bumpOrgEpoch` to the fresh epoch, return `{ policy: fresh, recompiled:
  true }`. Test (Testcontainers pg+redis): seed org + agent + spend(cap $10) + alloc, compile blob
  at epoch E and `bumpOrgEpoch` to E → resolve returns the cached blob, `recompiled === false`.
  Edit spend to cap $5 (epoch E+1) + `bumpOrgEpoch` to E+1 → resolve returns `recompiled === true`,
  `policy.spend.spendCap === usdc(5)` (the NEW version), and the call completes in `< 500ms`. A
  missing counter (null) also forces `recompiled === true`.
- [x] **L3 — SPIKE-05 bench + record.** `test/spikes/policy-epoch-propagation.test.ts` (Testcontainers
  pg+redis): (a) measure ms to sequentially `publishEffectivePolicy` N representative blobs for
  N = 100 / 1000 / 5000 (the propagation tail / worst-case stale window); (b) over K = 50 samples,
  time the full guard path on a forced epoch-miss (inline recompile incl. Postgres), report
  p50/p99, assert p99 `< 500ms`. `console.log` all numbers; loose CI ceilings (Docker-bridge
  overhead, not the calibrated budget). Then write the SPIKE-05 section into `spike-results.md`
  (PASS + measured evidence) and flip its row to ✅.

## Acceptance (doc 04 §3 M4 + §4 SPIKE-05 + gate NFR-03)
A policy edit bumps the epoch; an authorize that loads a stale blob recompiles inline under 500ms
and evaluates against the new version; the counter is monotonic and never regresses; propagation
tail + inline-recompile latency are recorded in `spike-results.md`. Contracts: C-1 (the blob).
NFR-03 cleared. SPIKE-05 (a HOT spike) passes → one of the five first-live-tx gates is satisfied.
