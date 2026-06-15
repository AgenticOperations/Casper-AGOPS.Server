-- 0004_admin_key_unique — enforce tenant isolation at the schema, not in code.
--
-- The operator admin surface (src/engines/control/admin-auth.ts) resolves an `sk_live_` bearer to an org
-- via `SELECT id FROM orgs WHERE admin_key_hash = $1` and takes the single row. That single-row assumption
-- (and the org-scoping of every monitoring/control route, engine-specs-FINAL.md:268) is only sound if the
-- hash is unique — mirroring the existing UNIQUE on `agents.api_key_hash` (0002_control.sql:41). Without it
-- a seeding/rotation bug that duplicated a hash would let an admin nondeterministically authenticate as
-- another tenant. Tokens are 192-bit random, so this index never trips in normal operation; it is the
-- fail-closed guarantee that a duplicate is rejected at write time rather than silently accepted.
CREATE UNIQUE INDEX orgs_admin_key_hash_idx ON orgs (admin_key_hash);
