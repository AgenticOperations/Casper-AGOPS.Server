-- 0011_treasury_deposits — operator-wallet deposit intent + idempotency ledger.
--
-- Flow: UI generates a deposit intent (ref_id, org_id, optional expected_amount).
-- The user sends CSPR to the operator wallet with ref_id as the transfer numeric id (memo).
-- POST /v1/treasury/verify-deposit queries Casper RPC for transfers to the operator
-- account whose id matches ref_id, then credits the org treasury and marks this row credited.
--
-- ref_id is a random uint64 stored as bigint (fits Casper transfer id field, max 2^64-1).
-- deploy_hash is set once the transfer is found on-chain (idempotency guard).

CREATE TABLE treasury_deposit_intents (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id          text NOT NULL REFERENCES orgs (id),
  ref_id          bigint NOT NULL UNIQUE,           -- Casper transfer id (memo) the user must include
  expected_amount numeric(78, 0),                   -- optional hint; not enforced, actual on-chain amount is credited
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'credited', 'expired')),
  deploy_hash     text,                             -- set on first successful match (idempotency)
  credited_amount numeric(78, 0),                   -- actual base-unit amount credited
  created_at      timestamptz NOT NULL DEFAULT now(),
  credited_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + INTERVAL '24 hours'
);

CREATE INDEX treasury_deposit_intents_org_idx ON treasury_deposit_intents (org_id);
CREATE INDEX treasury_deposit_intents_ref_idx ON treasury_deposit_intents (ref_id);
CREATE INDEX treasury_deposit_intents_status_idx ON treasury_deposit_intents (status);
