# Backend _handoff Notes

Master tracking lives in `BUILD/_handoff/` (MASTER-TASKLIST, DECISIONS, GROUND-TRUTH, PROGRESS-LOG,
CREDENTIALS-NEEDED). This file = backend-specific working notes.

## What this backend is
Fastify 5 + Postgres 16 + Redis 7 single-operator payment-enforcement engine. Real x402/EIP-3009
signing + hold-inclusive spend caps + kill-switch + double-entry ledger. 24 routes, 210 tests.
See GROUND-TRUTH.md for the full map (routes, schema, web3 status, key model).

## What we're adding (Phase 1) — identity & access layer, NET-NEW
Extends (does NOT replace) the existing Org→Team→Agent + sk_/ag_ key model:
- Migration `0005`: users, sessions, memberships (user↔org↔role), api_keys (sk_ issuance/rotation),
  email_verification_tokens, password_reset_tokens, oauth_accounts (google).
- Auth: register/login/logout (argon2/bcrypt + httpOnly secure session cookie), email verify, password
  reset, Google OAuth (OIDC, credential-gated).
- Org-create route (wires createOrg + issueAdminKey); memberships + RBAC middleware (owner/admin/member).
- API-key mgmt routes (issue/rotate/revoke sk_); agent CRUD routes (create/name/retire + ag_ issue/rotate).
- Rate limiting / abuse controls.

## Conventions to follow (match existing code)
- TS strict, ESM/NodeNext. Forward-only migrations via `src/db/migrate.ts`. Fastify route registration
  pattern per existing engines/*/routes.ts. Auth as function calls inside handlers (existing pattern)
  OR Fastify hooks — match existing `authenticateAdmin`/`authenticateAgent` style (`engines/control/admin-auth.ts`,
  `engines/oracle/auth.ts`). Vitest + Testcontainers for tests. SHA-256 hashing already used for keys —
  use a proper password hash (argon2id) for user passwords, NOT SHA-256.
- Money = numeric(78,0) / string. Append-only ledgers. Deny-by-default / fail-closed on control writes.
- Keep sk_/ag_ fence intact. New session/cookie auth is a THIRD credential class for human operators —
  it must resolve to a user → membership → org, then the existing org sk_ powers act on that org.

## Open backend debts (pre-existing)
- #95: 24 `no-unsafe-*` eslint errors. #60: policy_assignments UNIQUE + ON CONFLICT.
- Circle stub, hardcoded Arc domain, Solana throw, AWS KMS unimplemented (see CREDENTIALS-NEEDED / Phase 4).
