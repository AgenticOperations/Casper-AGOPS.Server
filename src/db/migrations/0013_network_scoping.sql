-- 0013_network_scoping — add per-network scoping so the UI can show testnet OR mainnet data.
--
-- casper_guard_decisions.network already exists (0009). This adds the same column to the tables
-- the Casper console reads/writes directly, so a network toggle can filter cleanly.
--
-- ZERO-DOWNTIME / TESTNET-SAFE: every column is added with DEFAULT 'casper:casper-test'. All existing
-- rows are testnet, so the default backfills them implicitly. The default is retained so any insert
-- path that has not yet been updated still produces a valid (testnet) row.

DO $$
BEGIN
  -- casper_guard_holds
  ALTER TABLE casper_guard_holds
    ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'casper:casper-test'
      CHECK (network IN ('casper:casper-test', 'casper:casper'));

  -- casper_guard_audit_anchors
  ALTER TABLE casper_guard_audit_anchors
    ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'casper:casper-test'
      CHECK (network IN ('casper:casper-test', 'casper:casper'));

  -- casper_guard_reconciliation_attempts
  ALTER TABLE casper_guard_reconciliation_attempts
    ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'casper:casper-test'
      CHECK (network IN ('casper:casper-test', 'casper:casper'));

  -- treasury_deposit_intents (Casper console reads /v1/treasury/*)
  ALTER TABLE treasury_deposit_intents
    ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'casper:casper-test'
      CHECK (network IN ('casper:casper-test', 'casper:casper'));
END $$;

CREATE INDEX IF NOT EXISTS casper_guard_holds_network_idx ON casper_guard_holds (network);
CREATE INDEX IF NOT EXISTS casper_guard_audit_anchors_network_idx ON casper_guard_audit_anchors (network);
CREATE INDEX IF NOT EXISTS treasury_deposit_intents_network_idx ON treasury_deposit_intents (network);
CREATE INDEX IF NOT EXISTS casper_guard_decisions_network_idx ON casper_guard_decisions (network);
