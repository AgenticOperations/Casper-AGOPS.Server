-- allocation-reserve.lua — P3-B atomic budget reserve (BUG-19, policy-engine-FINAL.md:253-262).
--
-- The whole point: check `available = total - committed - reserved` and INCR `reserved` in ONE
-- atomic step, so two concurrent depositFor requests can never both pass the budget check and then
-- both reserve (which would oversubscribe the org's total loss-dial). KEYS[1]=allocation_committed,
-- KEYS[2]=allocation_reserved; ARGV[1]=total_budget, ARGV[2]=requested (USDC base units).
--
-- Returns 1 if the reservation was taken (reserved += requested), 0 if it would exceed the budget.
-- Amounts are < 2^53 for any realistic org budget, so the numeric compare is exact; the stored
-- counters are integers (INCRBY is exact) — mirroring the ledger reserve counter.
local committed = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
local total = tonumber(ARGV[1])
local requested = tonumber(ARGV[2])

local available = total - committed - reserved
if requested > available then
  return 0
end

redis.call('INCRBY', KEYS[2], ARGV[2])
return 1
