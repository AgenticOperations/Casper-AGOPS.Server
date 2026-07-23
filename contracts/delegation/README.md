# Delegation session contracts (Milestone A spike, resolved)

Two small session Wasm contracts implementing the D-2① / D-2④ associated-key delegation scheme:
grant a bounded delegated key to an account, and revoke it. Adapted from Casper's own
[two-party-multi-sig reference](https://github.com/casper-ecosystem/two-party-multi-sig) (which
Casper's docs note "is not a general-purpose program and needs to be modified for each use case")
— modified into an **asymmetric** delegation scheme instead of that reference's balanced 2-of-2.

## Why this isn't the reference's scheme

The reference raises both keys to the same weight and both thresholds to a value only reachable by
both keys together (true multi-sig). D-2① wants the opposite: the agent's key should be able to
transact **alone** (deploy threshold stays low), but should **never** alone be able to touch
key-management (add/remove keys, change thresholds) — that stays exclusive to the master.

Naively doing only "add agent at weight 1, raise key-management threshold to 3" (as the milestone
doc's threshold numbers alone might suggest) would **brick the account**: verified against a real
account before writing this contract, a fresh/default account starts with its own key at weight 1.
Agent (1) + master (1) = 2, which never reaches a raised threshold of 3 — nobody could ever manage
keys on that account again. `grant-delegated-key` avoids this by ALSO bumping the master's own
weight (via `update_associated_key`, since the master's key already exists — distinct from
`add_associated_key` used for the new agent key) in the same deploy, so the master alone still
satisfies the raised key-management threshold.

## Building

```
cd grant-delegated-key && cargo build --target wasm32-unknown-unknown --release
cd ../revoke-delegated-key && cargo build --target wasm32-unknown-unknown --release
```

Requires the pinned nightly in `rust-toolchain.toml` (`nightly-2025-01-15`) — `casper-contract`
5.1.1 uses unstable features (`alloc_error_handler`, `core_intrinsics`, `lang_items`) that a
current-dated nightly rejects (a `#[no_mangle]` panic-handler lang-item conflict). This specific
date is verified to compile both contracts cleanly.

## Verified live on Casper testnet (2026-07-23)

Tested against a **fresh throwaway account pair**, never the real operator/master account that
owns the live GuardRegistry contract:

1. **Grant**: `casper-client put-deploy --session-path grant-delegated-key.wasm --session-arg
   "agent_account_hash:account_hash='...'" --session-arg "master_weight:u8='3'"
   --session-arg "key_management_threshold:u8='3'" --session-arg "deployment_threshold:u8='1'"`.
   Result: `status: "processed"`. `query_global_state` confirmed
   `associated_keys: [{agent, weight:1}, {master, weight:3}]`,
   `action_thresholds: {deployment:1, key_management:3}`.
2. **Delegated key transacts alone**: a `casper-client transfer` signed with ONLY the agent's
   secret key, with `--session-account <master's public key>`, was accepted and processed
   (`caller_hash` = master's account, `error_message: null`) — the agent authorized a real deploy
   on the master's account without the master's key touching it.
3. **Revoke**: `revoke-delegated-key.wasm --session-arg "agent_account_hash:..."` (signed by
   master). Result: `status: "processed"`. `query_global_state` confirmed the agent's key is
   entirely gone from `associated_keys`; only master (weight 3) remains, thresholds unchanged.
4. **Revocation actually enforced**: repeating step 2's transfer with the SAME agent key after
   revoke was rejected outright by the node: `"invalid associated keys"` — not merely "denied by
   policy," rejected at the protocol level. The agent cannot authorize anything on that account
   ever again unless re-granted.

Full deploy hashes are in the 2026-07-23 session transcript (grant:
`97c50ddf96d555d3fdf72ecfae68ec7d6ad778118c1cea31eed589ec29410db6`, transfer-while-granted:
`426495a54c4d9df9049d2e2fc9f1f482c0617aaf73b53e0a6bcbfd11db8e40b7`, revoke:
`0a6cce3345d91abeb6a44271732a895d852a1c05f5b0afc530bf65151e1118f6`) — all independently verifiable
via `api.testnet.cspr.cloud/deploys/<hash>` or `query_global_state` on the throwaway master account
hash `account-hash-ba1b44413a7b9593843b013c078aef9d9cbe43fc77efe0a8673513d94333dc40`.

## Wiring this into `associated-keys.ts`

`src/engines/identity/delegation/associated-keys.ts`'s `buildGrantDeployArgs`/
`buildRevokeDeployArgs` currently only compute the weight/threshold VALUES — they don't yet
construct the actual deploy (session Wasm + args + `SessionBuilder`). That's the remaining wiring
step: load these compiled `.wasm` files as session bytes, build a `SessionBuilder` (or the legacy
`put-deploy` shape, matching whichever transaction API the target Casper node version accepts —
this test used the deprecated `put-deploy` since `put-transaction` support for arbitrary session
Wasm wasn't verified in this pass), and pass `buildGrantDeployArgs`'s output as the named args
(`agent_account_hash`, `master_weight`, `key_management_threshold`, `deployment_threshold`).

**Important:** `buildGrantDeployArgs`'s current return shape (`account`, `weight`,
`action_threshold_deployment`, `action_threshold_key_management`) does NOT yet include
`master_weight` — it needs an added field for the master's own new weight, since this contract
requires it as a named arg. Update the function signature to accept and return that before wiring.
