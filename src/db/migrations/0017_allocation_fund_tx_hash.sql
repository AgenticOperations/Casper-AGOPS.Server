-- 0017_allocation_fund_tx_hash — surface the JIT on-chain funding tx in the console.
--
-- When a delegated-key agent's float is provisioned, fundAgentOnChain submits a WCSPR `transfer` to
-- the agent's own account (see agent-funding.ts). Its tx hash is captured on the Redis allocation
-- record at submit; on L3 confirm we persist it here so the treasury float-movement history can render
-- a block-explorer link. Nullable: pre-existing rows, and agents without a delegated key (no on-chain
-- funding), simply have no hash and show no link.
ALTER TABLE allocation_events ADD COLUMN IF NOT EXISTS fund_tx_hash text;
