-- 0016_delegated_key_grant_state — Half-2 on-chain grant tracking (D-2②).
--
-- A delegated key is usable proxy-side the moment it is granted (Half-1), but only has on-chain
-- authority once the user's master key signs the update_associated_keys deploy (Half-2). This
-- column records that second state WITHOUT overloading `status` (ACTIVE/ROTATED/REVOKED lifecycle).
--
-- ADDITIVE / SAFE: default 'pending' means every EXISTING active key is treated as not-yet-
-- on-chain-confirmed (correct — none went through Half-2 before this existed).

ALTER TABLE delegated_keys
  ADD COLUMN IF NOT EXISTS grant_state text NOT NULL DEFAULT 'pending'
    CHECK (grant_state IN ('pending', 'granted')),
  ADD COLUMN IF NOT EXISTS grant_deploy_hash text,
  ADD COLUMN IF NOT EXISTS granted_on_chain_at timestamptz;

CREATE INDEX IF NOT EXISTS delegated_keys_grant_state_idx ON delegated_keys (grant_state);
