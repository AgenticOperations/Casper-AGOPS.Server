-- 0001_init — foundation for the agentOps cold tier.
--
-- Establishes the extensions every later migration depends on. Engine tables
-- (orgs/agents/policies in M2, ledger events in M3, identity in M7) arrive in
-- subsequent numbered migrations; this one only lays the substrate.

-- gen_random_uuid() for surrogate keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Case-insensitive text for org/agent handles and lookup keys.
CREATE EXTENSION IF NOT EXISTS citext;
