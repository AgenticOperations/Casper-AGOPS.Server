-- 0002_control — Engine 1 (Control) cold tier: tenancy hierarchy + immutable versioned policies.
--
-- org → team → agent hierarchy (single tenant boundary = org_id). Policies are immutable:
-- a version is identified by (policy_id, version) and never updated in place; an edit inserts
-- a new version (see src/engines/control/store.ts). Effective policy is compiled from the
-- assignments below as the most-restrictive intersection root→leaf.
--
-- Invariant (engine-specs-FINAL.md:276-277): an agent holds NO private key. The agents table
-- stores only a bearer-token hash; signing keys live exclusively in the KMS.

CREATE TABLE orgs (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  admin_key_hash text NOT NULL,
  -- per-org monotonic epoch; bumped on every policy version write (NFR-03 stale-cache guard)
  policy_epoch   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES orgs (id),
  parent_team_id text REFERENCES teams (id),
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_org_idx ON teams (org_id);

CREATE TABLE agents (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs (id),
  team_id      text REFERENCES teams (id),
  -- hash of the ag_live_ bearer token; NEVER a signing key (agent holds none)
  api_key_hash text NOT NULL,
  -- ERC-8004 passport id, issued read-side in M7
  passport_id  text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_org_idx ON agents (org_id);
CREATE UNIQUE INDEX agents_api_key_hash_idx ON agents (api_key_hash);

CREATE TABLE policies (
  policy_id  text NOT NULL,
  version    integer NOT NULL,
  org_id     text NOT NULL REFERENCES orgs (id),
  class      text NOT NULL CHECK (class IN ('spend', 'allocation')),
  rules      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- a version is immutable; an edit inserts a new (policy_id, version)
  PRIMARY KEY (policy_id, version)
);
CREATE INDEX policies_org_idx ON policies (org_id);

CREATE TABLE policy_assignments (
  id         text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES orgs (id),
  scope      text NOT NULL CHECK (scope IN ('org', 'team', 'agent')),
  -- the org_id / team_id / agt_id the policy attaches to
  scope_id   text NOT NULL,
  policy_id  text NOT NULL,
  class      text NOT NULL CHECK (class IN ('spend', 'allocation')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_assignments_scope_idx ON policy_assignments (scope, scope_id);
