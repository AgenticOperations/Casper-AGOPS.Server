-- 0006_membership_apikeys — the org access plane: who belongs to an org (memberships+role) and which
-- machine keys an org has (api_keys, multiple + rotatable). Backward-compatible by construction:
--   * memberships carry the RBAC role (owner|admin|member); existing sk_ flows that resolve via
--     orgs.admin_key_hash keep working until each route migrates to authenticatePrincipal.
--   * api_keys is the new home for sk_live_ keys (multiple per org, revocable, last-used tracked). We
--     BACKFILL every existing orgs.admin_key_hash into api_keys (label 'legacy-admin') so the unified
--     resolver finds them in the new table; the legacy column is RETAINED this phase as a fallback path.

CREATE TABLE memberships (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id     text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);
CREATE INDEX memberships_org_idx ON memberships (org_id);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE api_keys (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- sha256 hex of the sk_live_ token; plaintext shown once at issue.
  key_hash     text NOT NULL,
  label        text NOT NULL DEFAULT '',
  -- non-secret display prefix, e.g. 'sk_live' — used for masked listings.
  prefix       text NOT NULL DEFAULT 'sk_live',
  -- user who minted it; NULL for the legacy backfill (no human author on record). ON DELETE SET NULL:
  -- the key belongs to the org, not the author, so deleting a user must not block or remove the key.
  created_by   text REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);

-- One-shot backfill: every org that already has an admin key gets a matching, non-revoked api_keys row,
-- so the unified resolver (P1c) accepts those existing sk_ keys against the new table on day one.
INSERT INTO api_keys (id, org_id, key_hash, label, prefix, created_by)
SELECT 'ak_legacy_' || o.id, o.id, o.admin_key_hash, 'legacy-admin', 'sk_live', NULL
FROM orgs o
WHERE NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash = o.admin_key_hash);
