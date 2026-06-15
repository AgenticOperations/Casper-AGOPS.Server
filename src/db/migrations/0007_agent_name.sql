-- 0007_agent_name — give agents a human-facing name and a 'retired' lifecycle state.
--
-- The original agents.status CHECK (0002) allowed only ('active','suspended'); retiring an agent (taking
-- it out of service without deleting its ledger history) needs a third terminal state. We drop+recreate
-- the CHECK to add 'retired', and add a NOT NULL name defaulting to '' (existing rows keep '' until renamed).
--
-- HOT-PATH CONSEQUENCE (src/engines/oracle/auth.ts): the agent-auth guard rejects any non-active status,
-- so adding 'retired' here automatically denies a retired agent's ag_ key on POST /v1/payment/authorize —
-- a deny-tightening, fail-closed change that never loosens 'active'/'suspended' behaviour.

ALTER TABLE agents ADD COLUMN name text NOT NULL DEFAULT '';

ALTER TABLE agents DROP CONSTRAINT agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('active', 'suspended', 'retired'));
