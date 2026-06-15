-- 0003_ledger — Engine 4 (Ledger) cold tier: per-payment audit + double-entry journals.
--
-- Two append-only journals (engine-specs-FINAL.md:147,152):
--   spend_events      — agent → external vendor (the x402 payment)
--   allocation_events — treasury → agent (internal float allocation)
-- plus payment_events, one audit row per payment (policy-engine-FINAL.md:228-231).
--
-- Double-entry (engine-specs-FINAL.md:165-166): every settlement appends two balanced rows
-- (one debit, one credit) that sum to zero. Rows are NEVER updated in place — an "edit" is a new
-- row. There is deliberately no UPDATE path, trigger, or rule on these tables; they are a journal.
--
-- Dual timestamps (NFR-01, engine-specs-FINAL.md:151): enforcement_timestamp is the QUOTED-time
-- snapshot used for all policy math; settlement_timestamp is the on-chain SETTLED time used for
-- accounting. On the two double-entry journals BOTH are NOT NULL — a row exists only once a
-- payment has settled. payment_events.settlement_timestamp is nullable because the denied/failed
-- audit (written by Enforcement in M5) never settles.
--
-- Amounts are USDC base units (6dp) stored as numeric(78,0): exact integer arithmetic, wide
-- enough for any uint256 on-chain value, never a float (money never loses a cent to rounding).

-- One audit row per payment: the full decision record (policy-engine-FINAL.md:228-231).
CREATE TABLE payment_events (
  payment_id            text PRIMARY KEY,
  agent_id              text NOT NULL REFERENCES agents (id),
  org_id                text NOT NULL REFERENCES orgs (id),
  -- Rail decomposes into scheme + chain per the Rail contract (C-2); arc vs solana is THE divergence.
  rail_scheme           text NOT NULL CHECK (rail_scheme IN ('raw-x402', 'circle-nano')),
  rail_chain            text NOT NULL CHECK (rail_chain IN ('arc', 'solana')),
  resource_id           text NOT NULL,
  requested             numeric(78, 0) NOT NULL CHECK (requested >= 0),
  consumed              numeric(78, 0) NOT NULL CHECK (consumed >= 0),
  -- the immutable policy version that governed the decision: `policy_…@vN`.
  policy_ref            text NOT NULL,
  state                 text NOT NULL CHECK (state IN (
                          'QUOTED', 'RESERVED', 'SIGNED', 'BROADCASTING',
                          'EXPIRY_CHECK', 'SETTLED', 'FAILED_TERMINAL', 'EXPIRED')),
  result                text NOT NULL CHECK (result IN ('ALLOW', 'DENY')),
  reason_code           text,
  enforcement_timestamp timestamptz NOT NULL,
  settlement_timestamp  timestamptz,
  recorded_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_agent_idx ON payment_events (agent_id);
CREATE INDEX payment_events_org_idx ON payment_events (org_id);

-- spend_events: agent → external. Two balanced rows per payment (debit agent-float, credit vendor).
CREATE TABLE spend_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id            text NOT NULL REFERENCES payment_events (payment_id),
  account               text NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount                numeric(78, 0) NOT NULL CHECK (amount >= 0),
  agent_id              text NOT NULL REFERENCES agents (id),
  org_id                text NOT NULL REFERENCES orgs (id),
  resource_id           text NOT NULL,
  enforcement_timestamp timestamptz NOT NULL,
  settlement_timestamp  timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spend_events_payment_idx ON spend_events (payment_id);
CREATE INDEX spend_events_agent_idx ON spend_events (agent_id);

-- allocation_events: treasury → agent. AllocationEvent (C-5) carries `kind`, never a payment_id;
-- allocation_id groups the balanced debit/credit pair of one allocation.
CREATE TABLE allocation_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  allocation_id         text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('depositFor', 'topup', 'teardown')),
  account               text NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount                numeric(78, 0) NOT NULL CHECK (amount >= 0),
  agent_id              text NOT NULL REFERENCES agents (id),
  org_id                text NOT NULL REFERENCES orgs (id),
  enforcement_timestamp timestamptz NOT NULL,
  settlement_timestamp  timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX allocation_events_agent_idx ON allocation_events (agent_id);
CREATE INDEX allocation_events_alloc_idx ON allocation_events (allocation_id);
