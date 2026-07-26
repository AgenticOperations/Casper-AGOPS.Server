-- allocation-reserve.lua — P3-B atomic budget reserve (BUG-19, policy-engine-FINAL.md:253-262).
--
-- The whole point: check `available = total - committed - reserved` and INCR `reserved` in ONE
-- atomic step, so two concurrent depositFor requests can never both pass the budget check and then
-- both reserve (which would oversubscribe the org's total loss-dial). KEYS[1]=allocation_committed,
-- KEYS[2]=allocation_reserved; ARGV[1]=total_budget, ARGV[2]=requested (USDC base units).
--
-- ARGV[3] = funded_total: the org's REAL deposited balance (sum of credited treasury_deposit_intents
-- for this network). This is the SOLVENCY ceiling and it is distinct from ARGV[1]: `total_budget` is a
-- policy dial (an intent — "never allocate more than this"), while `funded_total` is custody truth
-- ("this much actually exists"). Without this second bound an org with ZERO deposits could still
-- allocate agent float up to its policy budget, promising money the treasury does not hold. Both
-- ceilings apply and the TIGHTER one wins; the caller distinguishes the two rejections via the return
-- code so the operator sees `treasury_insufficient_funds`, not a misleading `allocation_exceeded`.
--
-- The solvency compare MUST live inside this script, not beside it: a check-then-reserve split would
-- let two concurrent deposits each read the same funded balance, both pass, and together overdraw the
-- real treasury — exactly the TOCTOU the atomic reserve exists to close.
--
-- Returns  1 = reservation taken (reserved += requested)
--          0 = would exceed the POLICY budget (total_budget)
--         -1 = would exceed REAL DEPOSITED FUNDS (funded_total) — treasury insolvent for this ask
-- Amounts are < 2^53 for any realistic org budget, so the numeric compare is exact; the stored
-- counters are integers (INCRBY is exact) — mirroring the ledger reserve counter.
local committed = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
local total = tonumber(ARGV[1])
local requested = tonumber(ARGV[2])
local funded = tonumber(ARGV[3])

local available = total - committed - reserved
if requested > available then
  return 0
end

-- Solvency ceiling: outstanding allocations (committed + reserved) plus this request may never exceed
-- what the org has actually deposited. Checked AFTER the policy bound so a request breaching both is
-- reported against the policy dial, and BEFORE the INCR so an insolvent ask reserves nothing.
local funded_available = funded - committed - reserved
if requested > funded_available then
  return -1
end

redis.call('INCRBY', KEYS[2], ARGV[2])
return 1
