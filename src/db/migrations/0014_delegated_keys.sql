-- 0014_delegated_keys — Milestone C (D-6): per-agent delegated Casper key lifecycle.
--
-- ACTIVE -> ROTATED / REVOKED. A partial unique index enforces the single-active-key invariant
-- (D-6①): at most one ACTIVE delegated key per agent at any time. Fleet grouping reuses the
-- existing agents.team_id (D-6②) — no new grouping entity here.

CREATE TABLE delegated_keys (
  id          text PRIMARY KEY,
  agent_id    text NOT NULL REFERENCES agents (id),
  public_key  text NOT NULL,
  weight      integer NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ROTATED', 'REVOKED')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE INDEX delegated_keys_agent_idx ON delegated_keys (agent_id);

-- The single-active-key invariant: inserting a second ACTIVE row for the same agent violates
-- this index, so callers must transition the old key to ROTATED/REVOKED in the same transaction
-- as inserting the new one.
CREATE UNIQUE INDEX delegated_keys_one_active_per_agent_idx
  ON delegated_keys (agent_id)
  WHERE status = 'ACTIVE';
