# Odra Guard Registry — build & deploy

Append-only on-chain registry of Casper Guard decision anchors.  
Entry points: `anchor_decision(decision_id, decision_hash)`, `get_anchor(decision_id)`, `total_anchored()`.

## Prerequisites (not installed on the dev machine by default)

```sh
# 1. Rust + wasm target
rustup target add wasm32-unknown-unknown

# 2. cargo-odra
cargo install cargo-odra
```

## Build

```sh
cd contracts/odra-guard-registry
cargo odra build
# Produces a .wasm artifact in wasm/
```

## Deploy to testnet

```sh
cargo odra livenet deploy \
  --secret-key /Users/kaushalchaudhari/Desktop/casper-testnet-secret_key.pem \
  --node-address https://node.testnet.casper.network/rpc \
  --chain-name casper-test
```

## After deploy

Record the **CONTRACT PACKAGE HASH** (64 hex chars) printed by the deploy command and add it to `Casper-AGOPS.Server/.env`:

```env
CASPER_GUARD_ODRA_PACKAGE_HASH=<64-char package hash>
CASPER_GUARD_ODRA_RPC_URL=https://node.testnet.casper.network/rpc
CASPER_GUARD_ODRA_ENTRY_POINT=anchor_decision
```

Restart the backend — `odra_anchor` will flip from `blocked` → `ready` in `/v1/casper-guard/setup-status`.
