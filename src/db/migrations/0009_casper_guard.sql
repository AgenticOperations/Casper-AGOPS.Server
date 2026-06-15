-- 0009_casper_guard — Casper-native hackathon product decision/audit store.
--
-- This is deliberately separate from payment_events: the existing Phase-1 ledger constrains
-- rails to Arc/Solana x402 and Circle Gateway. Casper Guard needs Casper x402, CSPR.trade, and
-- direct deploy/action evidence without weakening those original AgentOps constraints.

CREATE TABLE casper_guard_decisions (
  decision_id          text PRIMARY KEY,
  idempotency_key      text NOT NULL,
  org_id               text NOT NULL REFERENCES orgs (id),
  agent_id             text NOT NULL REFERENCES agents (id),
  action_kind          text NOT NULL CHECK (action_kind IN ('x402-payment', 'cspr-trade', 'casper-deploy')),
  network              text NOT NULL CHECK (network IN ('casper:casper-test', 'casper:casper')),
  resource_id          text NOT NULL,
  amount               numeric(78, 0) NOT NULL CHECK (amount > 0),
  asset_kind           text NOT NULL CHECK (asset_kind IN ('cep18', 'native')),
  asset_ref            text NOT NULL,
  destination          text,
  status               text NOT NULL CHECK (status IN (
                         'QUOTED', 'RESERVED', 'SIGNED', 'BROADCASTING',
                         'EXPIRY_CHECK', 'SETTLED', 'DENIED', 'FAILED_TERMINAL', 'EXPIRED')),
  outcome              text NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
  reason_code          text,
  policy_ref           text NOT NULL,
  signer_kind          text,
  raw_requirement_hash text,
  signed_header_hash   text,
  tx_hash              text,
  deploy_hash          text,
  intent_json          jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (outcome = 'DENY' AND status = 'DENIED' AND reason_code IS NOT NULL AND signed_header_hash IS NULL)
    OR
    (outcome = 'ALLOW' AND status <> 'DENIED' AND reason_code IS NULL)
  ),
  CHECK (
    (status IN ('QUOTED', 'RESERVED', 'DENIED') AND signed_header_hash IS NULL)
    OR
    (status IN ('SIGNED', 'BROADCASTING', 'EXPIRY_CHECK', 'SETTLED') AND signed_header_hash IS NOT NULL)
    OR
    (status IN ('FAILED_TERMINAL', 'EXPIRED'))
  ),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX casper_guard_decisions_agent_idx ON casper_guard_decisions (agent_id);
CREATE INDEX casper_guard_decisions_org_idx ON casper_guard_decisions (org_id);
CREATE INDEX casper_guard_decisions_status_idx ON casper_guard_decisions (status);

CREATE TABLE casper_guard_holds (
  hold_id     text PRIMARY KEY,
  decision_id text NOT NULL UNIQUE REFERENCES casper_guard_decisions (decision_id) ON DELETE CASCADE,
  org_id      text NOT NULL REFERENCES orgs (id),
  agent_id    text NOT NULL REFERENCES agents (id),
  amount      numeric(78, 0) NOT NULL CHECK (amount > 0),
  asset_kind  text NOT NULL CHECK (asset_kind IN ('cep18', 'native')),
  asset_ref   text NOT NULL,
  status      text NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX casper_guard_holds_agent_idx ON casper_guard_holds (agent_id);
CREATE INDEX casper_guard_holds_status_idx ON casper_guard_holds (status);

CREATE TABLE casper_guard_reconciliation_attempts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decision_id    text NOT NULL REFERENCES casper_guard_decisions (decision_id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  source         text NOT NULL CHECK (source IN ('facilitator', 'casper-rpc', 'cspr-cloud', 'operator-wallet')),
  status         text NOT NULL CHECK (status IN ('pending', 'settled', 'failed', 'ambiguous')),
  evidence       jsonb NOT NULL,
  error_code     text,
  observed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, attempt_number)
);
CREATE INDEX casper_guard_reconcile_decision_idx ON casper_guard_reconciliation_attempts (decision_id);

CREATE TABLE casper_guard_audit_anchors (
  anchor_id     text PRIMARY KEY,
  decision_id   text NOT NULL REFERENCES casper_guard_decisions (decision_id) ON DELETE CASCADE,
  anchor_kind   text NOT NULL CHECK (anchor_kind IN ('odra-guard-registry')),
  decision_hash text NOT NULL,
  status        text NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
  tx_hash       text,
  anchored_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id, anchor_kind, decision_hash)
);
CREATE INDEX casper_guard_anchor_decision_idx ON casper_guard_audit_anchors (decision_id);
