# AgentOps — Backend

AgentOps is the CasperHacks backend: a Casper-native policy, x402 signing,
MCP, reconciliation, and audit layer for AI agents spending on Casper rails.
It signs or denies every agent action, records the decision, reserves budget,
and exposes judge-verifiable audit JSON for the operator console.

> This is a CasperHacks product. It is not the canonical `agentOps` project and
> should not be treated as a mutation of that codebase.

## Stack

Node 20 · TypeScript (strict, ESM) · Fastify · Postgres (cold tier) · Redis + AOF
(hot tier) · `@make-software/casper-x402` · MCP JSON-RPC · Vitest + Testcontainers.

## Layout

```
src/
  config/env.ts      zod-validated environment (the only reader of process.env)
  db/                Postgres pool + forward-only migration runner + migrations/
  redis/             ioredis client + the typed keyspace
  contracts/         the 12 typed cross-engine edges (C-1..C-12) — types only
  lib/               Casper x402/signer plus inherited payment substrate seams
  engines/           control · custody · ledger · resolution · enforcement ·
                     oracle · provisioning · identity · monitoring · casper-guard
  http/              admin (Group A) · query (Group B) · reports (Group C)
  app.ts             Fastify app factory (test via .inject)
  server.ts          process entrypoint
```

## Develop

```bash
npm install
cp .env.example .env          # fill in real values; never commit .env
npm run infra:up              # Postgres + Redis (Redis with AOF, per NFR-02)
npm run migrate               # apply schema migrations
npm run dev                   # tsx watch on src/server.ts
```

## AgentOps Runtime

The Casper surface is wired from env at boot and fails closed when anything live is
missing:

- `CASPER_GUARD_SIGNER_MODE=disabled|local-testnet|operator-wallet|enterprise-custody`
- `CASPER_GUARD_SIGNER_PEM_PATH=/path/to/testnet-key.pem` for local testnet signing
- `CASPER_GUARD_NETWORKS=casper:casper-test`
- `CASPER_GUARD_ODRA_PACKAGE_HASH` and `CASPER_GUARD_ODRA_RPC_URL` report Odra binding readiness

Client-facing endpoints:

- `GET /v1/casper-guard/capabilities`
- `GET /v1/casper-guard/setup-status`
- `POST /v1/casper-guard/authorize-x402`
- `POST /v1/casper-guard/authorize-action`
- `GET /v1/casper-guard/decisions/:decisionId/status`
- `GET /v1/casper-guard/decisions/:decisionId/audit`
- `POST /v1/casper-guard/decisions/:decisionId/reconcile`
- `POST /v1/casper-guard/mcp`

## Quality gates

```bash
npm run typecheck   # strict tsc, no emit
npm run lint        # eslint (flat config, type-checked rules)
npm run format:check
npm test            # AgentOps + required core backend tests
npm run test:full-substrate  # inherited AgentOps substrate, including legacy Arc/Circle tests
```

Project state and remaining work live in `../../HANDOFF.md`.
