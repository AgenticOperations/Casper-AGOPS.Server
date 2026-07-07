# AgentOps — Casper Backend

AgentOps is a **CasperHacks product** — a Casper-native policy engine, x402 payment signer, and audit layer for AI agents spending on Casper rails. Every agent action is authorized, budget-held, signed (or denied), reconciled against the chain, and anchored on-chain via the Odra GuardRegistry contract. A judge-verifiable audit record is available at every step.

> This is a distinct product built for CasperHacks. It is not the canonical `agentOps` project.

---

## Why Casper

| Reason | How it shows up here |
|--------|---------------------|
| **x402 native** | `@make-software/casper-x402` gives exact-payment-scheme x402 v2 out of the box — no EIP-712 ceremony |
| **Asset-neutral** | CEP-18 tokens referenced by 64-char package hash; wCSPR, custom tokens, and metadata versioning all work |
| **CSPR.trade DEX** | MCP-discoverable trade quotes and swaps natively in the policy gate |
| **Direct deploys** | Policy can authorize and reconcile any Casper deploy, not just payments |
| **On-chain audit** | Odra GuardRegistry anchors every decision hash; audit proof is immutable and on-chain |

---

## Stack

```
Node 20 · TypeScript strict ESM · Fastify 5 · Postgres 16 · Redis 7 (AOF) ·
@make-software/casper-x402 · casper-js-sdk · MCP JSON-RPC · Vitest + Testcontainers
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  HTTP API  (Fastify routes, MCP JSON-RPC endpoint)      │
├─────────────────────────────────────────────────────────┤
│  10 Engines  (pluggable, fail-closed, injected at boot) │
│                                                         │
│  E1 Control        policy versioning, epoch bumps       │
│  E2 Custody        balance reads (read-side only)       │
│  E3 Enforcement    hot path: sign or deny               │
│  E4 Ledger         double-entry audit journal           │
│  E5 Settlement     on-chain finality confirmation       │
│  E6 Provisioning   agent float, Circle depositFor       │
│  E7 Identity       RBAC (owner/admin/member), ERC-8004  │
│  E8 Monitoring     decision stream, kill-switch         │
│  E9 Oracle         agent bearer auth                    │
│  casper-guard      Casper x402 / CSPR.trade / deploys   │
├─────────────────────────────────────────────────────────┤
│  Hot tier  (Redis + AOF)                                │
│  spend windows · allocation reserves · holds · floats   │
├─────────────────────────────────────────────────────────┤
│  Cold tier  (Postgres)                                  │
│  policies · decisions · immutable double-entry ledger   │
├─────────────────────────────────────────────────────────┤
│  External seams (all credential-gated, fail-closed)     │
│  Casper RPC · x402 Facilitator · Odra contract          │
│  Circle Gateway · AWS KMS · Google OAuth                │
└─────────────────────────────────────────────────────────┘
```

### Layout

```
src/
  config/
    env.ts              Zod-validated env (single reader of process.env, ~85 vars)
    casper-guard.ts     Wires Casper signer, networks, settlement readers, Odra anchorer
    hotpath.ts          EIP-712 domain resolution + KMS signer for Arc legacy path
  db/                   Postgres pool, forward-only migration runner, 12 SQL migrations
  redis/                ioredis client, typed keyspace (spend windows, allocations, holds)
  contracts/index.ts    12 typed cross-engine edge types (C-1..C-12)
  lib/
    casper/             x402 library, signer provider, settlement reader, Odra anchorer, CSPR.trade
    kms/signer.ts       Role-fenced signing seam (agent-float ↔ treasury-allocation)
    circle/             Circle Gateway client (HTTP + Redis stub transports)
    eip712/             EIP-712 domain resolution (viem), EIP-3009 transfer types
    lcp/                Legal Context Protocol discovery (/.well-known/legal-context.json)
    ids.ts              Typed ID generators (org_, agt_, pay_, alloc_, cgd_, ...)
  engines/              10 engine folders (control · custody · enforcement · ledger · ...)
  app.ts                Fastify app factory (dependency injection, route registration)
  server.ts             Process entrypoint (boot validation, background workers)
contracts/
  odra-guard-registry/  Rust Odra contract (anchor_decision, get_anchor, total_anchored)
```

---

## Core Workflows

### 1 — Agent Authorization (Casper x402 Payment)

```
Agent sends:  POST /v1/casper-guard/authorize-x402
              Bearer: ag_live_...  +  payment_required (x402 v2 schema)

 1. Authenticate bearer → agent_id, org_id
 2. Normalize payment_required → CasperGuardIntent (x402-payment kind)
 3. LCP discovery — fetch /.well-known/legal-context.json for the resource domain
 4. Resolve effective policy (org → team → agent, most-restrictive)
    Checks: org suspended · agent suspended · action kind allowed · network allowed ·
            resource in serviceScope · per-tx max · velocity limit · spend cap · budget reserve
 5. DENY path
    └─ Record decision (DENIED), no signer called, return 403 {reason_code}
 6. ALLOW path
    ├─ Place hold atomically (Redis NX) → casper_guard_holds.RESERVED
    ├─ Resolve CasperSignerProvider (local-testnet / operator-wallet / enterprise-custody)
    ├─ Call signer.sign → PAYMENT-SIGNATURE header via @make-software/casper-x402
    ├─ Record decision (SIGNED) + signed_header_hash
    └─ Return 200 {decision_id, hold_id, payment_header, audit_summary}
```

### 2 — Action Authorization (CSPR.trade / Deploy / EVM)

Same policy gate and hold lifecycle as x402. Intent kind determines signing path:

| Intent kind | What happens |
|-------------|-------------|
| `cspr-trade` | Slippage cap + risk label allowlist check, then CSPR.trade executor |
| `casper-deploy` | Deploy hash authorized and recorded, RPC reader polls finality |
| `evm-transfer` | Legacy Arc-compatible EVM transfer (backward compat) |

### 3 — Reconciliation & On-Chain Anchoring

```
Agent sends:  POST /v1/casper-guard/decisions/{decisionId}/reconcile
              {settlement: {status, source, evidence, txHash?}}

 1. Read decision from DB
 2. Run CasperGuardSettlementReader:
    a. If CASPER_GUARD_FACILITATOR_URL set → call facilitator /settle (x402 only)
    b. Else → poll Casper RPC (info_get_deploy) for finality
    c. Compose: live reader wins if conclusive; body fallback if still pending
 3. Terminal state (settled / failed / expired):
    ├─ Anchor decision hash to Odra GuardRegistry (if ODRA_PACKAGE_HASH set)
    │  └─ OdraGuardRegistryAnchorer → CasperDeploySubmitter → anchor_decision entry point
    ├─ Release hold (casper_guard_holds → RELEASED, Redis increment allocationReserved)
    └─ Record reconciliation_attempt + audit_anchor rows
 4. Return {outcome, status, anchored, tx_hash}
```

### 4 — Treasury & Agent Float

```
Admin:  POST /v1/treasury/deposit {amount}
        └─ Circle Gateway depositFor → on-chain USDC mint
        └─ Confirmation worker: finality → Redis allocationReserved

Admin:  POST /v1/agents/{id}/float {amount}
        └─ Eval AllocationPolicy (per-agent max, budget, cooldown)
        └─ Reserve in Redis, Circle depositFor, mark float PENDING
        └─ Confirmation worker: finality → promote to confirmed, record allocation_events

Alternative (Casper Native):
  POST /v1/treasury/deposit-intent   → generate ref_id + operator account hash
  Operator manually sends CSPR       → transfer id = ref_id
  POST /v1/treasury/verify-deposit   → scan recent blocks, credit org treasury
```

### 5 — Audit & Reporting

```
GET /v1/casper-guard/decisions/{id}/audit
    Full judge-verifiable JSON: decision + hold + reconciliation_attempts + audit_anchors

GET /v1/reports/statement
    Ledger summary: spend_events (agent→vendor) + allocation_events (treasury→agent)

GET /v1/reports/audit-log
    Immutable payment_events export (CSV / JSON)
```

### 6 — Identity & Access (Human Operators)

```
Register / login (email+password or Google OAuth)
  └─ httpOnly session cookie

Create org  → owner role assigned
  └─ Invite members (owner) → member accepts token → role (owner/admin/member)

Issue API key  → sk_live_... shown once, stored as SHA-256 hash
Create agent   → ag_live_... shown once, stored as SHA-256 hash

All org routes are tenant-fenced: principal org == path param org_id, RBAC enforced at route level
```

---

## MCP Surface

Agents discover and call AgentOps through a single MCP JSON-RPC endpoint:

```
POST /v1/casper-guard/mcp
Authorization: Bearer ag_live_...

tools:
  casper_guard_policy_check      Dry-run: does this intent pass policy?
  casper_guard_authorize_payment Sign an x402 payment (returns PAYMENT-SIGNATURE)
  casper_guard_authorize_action  Sign a CSPR.trade / deploy / EVM action
  casper_guard_reconcile         Report settlement, anchor, release hold
  casper_guard_decision_status   Current status of a decision
  casper_guard_audit_export      Full audit JSON for a decision
  casper_guard_legal_context     Fetch LCP context for a resource domain
```

---

## Casper Signer Modes

| Mode | Key source | Status |
|------|-----------|--------|
| `local-testnet` | PEM file (`CASPER_GUARD_SIGNER_PEM_PATH`) or inline base64 (`CASPER_GUARD_SIGNER_PEM_INLINE`) | **READY** |
| `operator-wallet` | Awaiting user approval | PENDING |
| `enterprise-custody` | HSM / Nitro (Phase 2) | UNAVAILABLE |
| `disabled` | No signing | BLOCKED |

Algorithm: `ed25519` (default) or `secp256k1` — set via `CASPER_GUARD_SIGNER_ALGORITHM`.

---

## Database Schema (key tables)

```
orgs                         tenant root, policy_epoch (stale-cache guard)
teams                        optional nesting inside an org
agents                       machine identity; bearer api_key_hash
policies                     immutable versioned rules (spend | allocation)
policy_assignments           scope (org|team|agent) → policy binding

users / sessions             human operators (httpOnly cookie auth)
memberships                  user ↔ org ↔ role
api_keys                     sk_live_ machine keys

payment_events               per-decision audit row (append-only)
spend_events                 double-entry: agent-float ↔ vendor
allocation_events            double-entry: treasury ↔ agent-float

casper_guard_decisions       decision record (intent_json, outcome, status, signed_header_hash)
casper_guard_holds           RESERVED → RELEASED budget hold
casper_guard_reconciliation_attempts   settlement evidence history
casper_guard_audit_anchors   Odra on-chain anchor (decision_hash, tx_hash)
```

All money stored as `numeric(78,0)` (exact, no float). Serialized to client as decimal string.  
Ledger tables are **append-only** — no in-place updates, ever.

---

## Migrations

12 forward-only SQL migrations in `src/db/migrations/`:

```
0001 init (pgcrypto, citext)
0002 control (orgs, teams, agents, policies, policy_assignments)
0003 ledger (payment_events, spend_events, allocation_events)
0004 admin_key_unique
0005 identity (users, sessions, oauth, token tables)
0006 memberships + API keys
0007 agent_name
0008 invitations
0009 casper_guard (decisions, holds, reconciliation, anchors)
0010 casper_guard signed_header_value
0011 treasury_deposits
0012 deposit_intent deploy_hash unique
```

---

## KMS & Role Fence

The signing seam enforces a strict role-to-operation fence before any byte is signed:

```
Role                   Operation              Used for
agent-float            external-spend         Send from agent float → vendor (x402)
treasury-allocation    internal-allocation    Send from treasury → agent float (Circle)
```

Mismatch → `SignerFenceViolation` thrown before the signer is called.  
`LocalKmsSigner` is used in tests/dev; `AWS KMS` is the production seam (Phase 2).

---

## Odra GuardRegistry Contract

On-chain, append-only decision anchor. Stores `decision_hash` keyed by `decision_id`. Re-anchoring the same hash is a no-op; a different hash for the same ID reverts.

```
contracts/odra-guard-registry/   (Rust, Odra framework)
  src/lib.rs       anchor_decision(id, hash), get_anchor(id), total_anchored()

Build:   cd contracts/odra-guard-registry && cargo odra build
Deploy:  cargo odra livenet deploy --secret-key ... --chain-name casper-test
Config:  CASPER_GUARD_ODRA_PACKAGE_HASH=<64-char hash>
         CASPER_GUARD_ODRA_RPC_URL=https://node.testnet.casper.network/rpc
```

Once deployed and configured, `odra_anchor` flips from `blocked` → `ready` in `/v1/casper-guard/setup-status`.

---

## API Reference

### Casper Guard

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/v1/casper-guard/capabilities` | member | Networks, signer mode, x402 version, MCP URL, Odra status |
| GET | `/v1/casper-guard/setup-status` | member | Ready / degraded / blocked with reason codes |
| POST | `/v1/casper-guard/authorize-x402` | agent | Sign x402 payment, return PAYMENT-SIGNATURE + decision_id |
| POST | `/v1/casper-guard/authorize-action` | agent | Sign CSPR.trade / deploy / EVM action |
| GET | `/v1/casper-guard/decisions/:id/status` | member | Decision status + tx hash + anchor count |
| GET | `/v1/casper-guard/decisions/:id/audit` | member | Full judge-verifiable audit JSON |
| POST | `/v1/casper-guard/decisions/:id/reconcile` | agent | Report settlement, anchor, release hold |
| POST | `/v1/casper-guard/mcp` | agent | MCP JSON-RPC endpoint |

### Treasury & Agents

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/treasury/deposit` | admin |
| POST | `/v1/treasury/deposit-intent` | admin |
| POST | `/v1/treasury/verify-deposit` | admin |
| GET | `/v1/treasury/balances` | member |
| GET | `/v1/treasury/history` | member |
| POST | `/v1/agents/:id/float` | admin |
| POST | `/v1/agents/:id/float/topup` | admin |

### Identity

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/auth/register` | — |
| POST | `/v1/auth/login` | — |
| POST | `/v1/auth/logout` | session |
| GET | `/v1/auth/google/start` | — |
| GET | `/v1/me` | session |
| POST | `/v1/orgs` | session |
| POST | `/v1/orgs/:id/api-keys` | admin |
| POST | `/v1/orgs/:id/agents` | admin |

### Health

```
GET /healthz         liveness (process up)
GET /readyz          readiness (Postgres + Redis reachable)
GET /v1/integrations/status   Circle + Arc modes (no secrets exposed)
```

---

## Key Environment Variables

```env
# Runtime
NODE_ENV=development
PORT=8080

# Database & cache
DATABASE_URL=postgres://casperguard:casperguard@localhost:5432/casperguard
REDIS_URL=redis://localhost:6379

# Casper signer
CASPER_GUARD_SIGNER_MODE=local-testnet         # disabled|local-testnet|operator-wallet|enterprise-custody
CASPER_GUARD_SIGNER_PEM_PATH=/path/to/key.pem  # or CASPER_GUARD_SIGNER_PEM_INLINE (base64)
CASPER_GUARD_SIGNER_ALGORITHM=ed25519           # or secp256k1
CASPER_GUARD_NETWORKS=casper:casper-test

# Casper settlement & anchoring
CASPER_GUARD_FACILITATOR_RPC_URL=https://node.testnet.casper.network/rpc
CASPER_GUARD_FACILITATOR_URL=https://x402-facilitator.cspr.cloud
CASPER_GUARD_ODRA_PACKAGE_HASH=<64-char hex>
CASPER_GUARD_ODRA_RPC_URL=https://node.testnet.casper.network/rpc

# CSPR.trade (DEX)
CSPR_TRADE_MAX_SLIPPAGE_BPS=100
CSPR_TRADE_ALLOWED_RISK_LABELS=low,medium

# Arc (EVM legacy)
ARC_RPC_URL=https://rpc.arc-testnet.example
ARC_CHAIN_ID=5042002
ARC_USDC_ADDRESS=0x...
GATEWAY_WALLET_ADDRESS=0x...
GATEWAY_MINTER_ADDRESS=0x...

# Circle
CIRCLE_API_KEY=secret
CIRCLE_GATEWAY_LIVE=false     # explicit opt-in; false → Redis stub

# KMS
KMS_PROVIDER=local            # local (dev) | aws (prod)
TREASURY_PRIVATE_KEY=0x...    # local-only
AGENT_FLOAT_PRIVATE_KEY=0x...

# Identity (P1)
SESSION_COOKIE_NAME=casper_guard_session
APP_BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URL=...
```

Full schema with defaults: `src/config/env.ts`.

---

## Develop

```bash
pnpm install
cp .env.example .env         # fill in values; never commit .env
pnpm run infra:up            # Postgres 16 + Redis 7 (AOF)
pnpm run migrate             # apply all 12 migrations
pnpm run dev                 # tsx watch (hot reload)
```

## Quality Gates

```bash
pnpm run typecheck           # strict tsc, no emit
pnpm run lint                # eslint flat config, type-checked rules
pnpm run format:check        # prettier
pnpm test                    # Vitest: casper + core (~210 tests)
pnpm run test:full-substrate # includes legacy Arc/Circle substrate tests
```

## Build & Run

```bash
pnpm run build               # tsc → dist/
node dist/src/server.js
```

---

## Design Principles

**Fail-closed everywhere.** Missing credentials → 503, not a silent default. Invalid env → boot failure.

**No fake Casper in production.** Tests use injectable seams (deterministic stub signers, mock RPC reads). Production paths are explicit and honest — `honest-blocked` is a valid state, not an error to hide.

**Immutable policy versioning.** Policies are append-only; updates create new versions. `policy_epoch` on each org guards against stale-cache reads.

**Hold-inclusive reserves.** Budget is reserved the moment a decision is signed. The hold stays until reconciliation is terminal (settled / failed / expired). An agent can never double-spend against an in-flight payment.

**Double-entry ledger.** Every spend and allocation records two balanced rows. Rows are never updated in place.

**Credential-gated integrations.** Circle, Arc, Google OAuth, and Odra all check their env at boot and report their ready/blocked state honestly. Flipping a mode to live requires an explicit env change, not a code change.
