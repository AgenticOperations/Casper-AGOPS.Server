-- 0012 — add unique index on deploy_hash for wallet-connect deposit idempotency.
-- Allows ON CONFLICT (deploy_hash) DO NOTHING in POST /v1/treasury/deposit-by-hash.
CREATE UNIQUE INDEX IF NOT EXISTS treasury_deposit_intents_deploy_hash_uidx
  ON treasury_deposit_intents (deploy_hash)
  WHERE deploy_hash IS NOT NULL;
