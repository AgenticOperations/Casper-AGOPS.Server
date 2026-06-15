-- 0008_invitations — member management (Members & RBAC). Net-new: an org OWNER invites a human by email
-- to join as 'admin' or 'member' (never 'owner' via invite). Same credential posture as the other
-- single-use, TTL'd tokens (email-verify, password-reset, sessions): we persist ONLY the sha256 hash of
-- the invitation token; the plaintext lives in the emailed accept link and is never stored. The accepting
-- human consumes the invite atomically (UPDATE ... WHERE accepted_at IS NULL AND expires_at > now()),
-- which also fences out a reused or expired token. invited_by is SET NULL on author deletion (the invite
-- belongs to the org, not the author).

CREATE TABLE invitations (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  -- sha256 hex of the 256-bit opaque accept token; plaintext lives only in the emailed link.
  token_hash  text NOT NULL UNIQUE,
  invited_by  text REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE INDEX invitations_org_idx ON invitations (org_id);
CREATE INDEX invitations_token_hash_idx ON invitations (token_hash);
