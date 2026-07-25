# Network-Aware Testnet/Mainnet Implementation Plan

**Goal:** Make the whole app honor the testnet/mainnet toggle end-to-end — backend routes select the correct env slot (RPC, operator account) by the request's network, UI text + explorer links follow the selected network, and `.env` holds both a real testnet slot and a real mainnet slot.

**Architecture:** The two-slot design already exists (base keys = testnet, `CASPER_GUARD_MAINNET_*` = mainnet; `resolveRequestNetwork` maps the `x-agentops-network` header). This plan closes the gaps: (1) backend routes that read the testnet slot directly get a shared `resolveCasperNetworkSlot(env, network)` helper; (2) frontend display components read `useNetwork()` for labels + explorer URLs; (3) `.env` restored to two real slots.

**Tech Stack:** Fastify + TypeScript backend, Next.js (App Router) client, zod env, pg/redis.

---

## Config value map (source of truth)

| Field | Testnet (base keys) | Mainnet (`MAINNET_*` keys) |
|---|---|---|
| Facilitator RPC | `https://node.testnet.casper.network/rpc` | `https://node.mainnet.casper.network/rpc` |
| Operator account | `60854d…4267` | `f9765d…4dd3` |
| Signer PEM | `…/casper-testnet-secret_key.pem` | `…/casper-mainnet-key/secret_key.pem` |
| Signer algo | `secp256k1` | `ed25519` |
| Odra package | `850b5056…d7ed` | `a003b2c3…f629` |
| Odra RPC | `http://65.109.115.124:7777` | `https://node.mainnet.casper.network/rpc` |

---

## Task 1: Backend network-slot resolver

**Files:**
- Create: `src/config/network-slot.ts`
- Test: `test/config/network-slot.test.ts`

Helper returns the RPC + operator for a resolved `CasperScopedNetwork`, falling back to base (testnet) keys when a mainnet key is empty.

```ts
// src/config/network-slot.ts
import type { Env } from './env.js';
import type { CasperScopedNetwork } from '../engines/casper-guard/network-header.js';

export interface CasperNetworkSlot {
  facilitatorRpcUrl: string;
  operatorAccountHash: string;
  odraRpcUrl: string;
  odraPackageHash: string;
}

export function resolveCasperNetworkSlot(env: Env, network: CasperScopedNetwork): CasperNetworkSlot {
  if (network === 'casper:casper') {
    return {
      facilitatorRpcUrl: env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL,
      operatorAccountHash: env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH,
      odraRpcUrl: env.CASPER_GUARD_MAINNET_ODRA_RPC_URL,
      odraPackageHash: env.CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH,
    };
  }
  return {
    facilitatorRpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL,
    operatorAccountHash: env.CASPER_OPERATOR_ACCOUNT_HASH,
    odraRpcUrl: env.CASPER_GUARD_ODRA_RPC_URL,
    odraPackageHash: env.CASPER_GUARD_ODRA_PACKAGE_HASH,
  };
}
```

Steps: write failing test (mainnet returns mainnet RPC/operator; testnet returns base) → implement → pass → commit.

---

## Task 2: treasury-routes selects slot by network

**Files:** Modify `src/engines/control/treasury-routes.ts`

Every place that reads `env.CASPER_GUARD_FACILITATOR_RPC_URL` / `env.CASPER_OPERATOR_ACCOUNT_HASH` inside a handler must instead resolve the network first and use `resolveCasperNetworkSlot(env, network).facilitatorRpcUrl / .operatorAccountHash`. Handlers already call `resolveRequestNetwork` or `selectGateway`; add `const slot = resolveCasperNetworkSlot(env, resolved.network)`.

Sites: deposit-intent address (~L111), verify-deposit rpc+operator (~L239/245), deposit-by-hash rpc+operator (~L347/350). Each handler already returns 400 on bad network.

Verify: for each network, the deposit **address** returned and the **RPC** queried match the slot. Manual curl with `x-agentops-network: casper:casper` returns the mainnet operator address; testnet returns `60854d…`.

Commit.

---

## Task 3: org-routes float destination by network

**Files:** Modify `src/engines/identity/org/org-routes.ts:78, 99`

`floatDestination` (org create + reseed-policies) uses `CASPER_OPERATOR_ACCOUNT_HASH`. Org creation isn't network-scoped at creation time; the float fence should allow BOTH operators. Change the seed to include both testnet and mainnet operator hashes in `allowedDestinations` when configured, so an agent funded on either network passes the fence. (Fallback to EVM addr unchanged.)

Commit.

---

## Task 4: Frontend network-aware display helpers

**Files:**
- Create: `src/lib/network/network-display.ts`
- Test: `src/lib/network/network-display.test.ts`

```ts
import type { CasperNetwork } from './network-storage';
export const networkLabel = (n: CasperNetwork) => (n === 'mainnet' ? 'Mainnet' : 'Testnet');
export const explorerBase = (n: CasperNetwork) => (n === 'mainnet' ? 'https://cspr.live' : 'https://testnet.cspr.live');
export const explorerTxUrl = (n: CasperNetwork, hash: string) => `${explorerBase(n)}/transaction/${hash}`;
export const explorerDeployUrl = (n: CasperNetwork, hash: string) => `${explorerBase(n)}/deploy/${hash}`;
```

Steps: failing test → implement → pass → commit.

---

## Task 5: Wire display helpers into components

**Files:** Modify
- `src/components/observability/DecisionRow.tsx:52` — replace hardcoded `https://testnet.cspr.live/transaction/${txHash}` with `explorerTxUrl(network, txHash)` where `network` comes from `useNetwork()`.
- `src/components/treasury/WalletDepositDialog.tsx` + `src/components/onboarding/FundTreasuryStep.tsx` — any explorer link / "testnet" copy → `networkLabel(network)` + explorer helper. Keep the `MIN_MOTES` comment accurate (both networks share the 2.5 CSPR min).
- `src/components/demo/McpSetupGuide.tsx:446, 222` — "Casper testnet …" → `Casper {networkLabel(network)} …` where a client component; if server component, leave copy generic ("Casper") rather than wrong.

Verify in browser: toggle → explorer links point at the right host; labels flip.

Commit.

---

## Task 6: Restore two-slot `.env`

**Files:** Modify `Casper-AGOPS.Server/.env`

- Base keys → real TESTNET values (from table).
- `CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL`, `CASPER_GUARD_MAINNET_ODRA_RPC_URL`, `CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH`, `CASPER_GUARD_MAINNET_SIGNER_PEM_PATH`, `CASPER_GUARD_MAINNET_SIGNER_ALGORITHM=ed25519`, `CASPER_MAINNET_OPERATOR_ACCOUNT_HASH=f9765d…` → real MAINNET values.
- Ensure `CASPER_GUARD_NETWORKS` includes `casper:casper`.

Restart backend (plain tsx). Verify: testnet balance/address correct; mainnet balance/address correct (mainnet gateway now builds).

Commit (`.env` is gitignored; commit only tracked code).

---

## Task 7: Full verification

- `pnpm exec tsc --noEmit` clean.
- Treasury test suite green (Docker up).
- Manual: toggle testnet → deposit address `60854d…`, explorer `testnet.cspr.live`; toggle mainnet → address `f9765d…`, explorer `cspr.live`.
