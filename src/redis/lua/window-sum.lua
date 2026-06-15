-- window-sum.lua — hold-inclusive spend-window read (BUG-14, policy-engine-FINAL.md:234-239).
--
-- Returns the amount of every hold whose enforcement-ts score is >= the snapshotted window lower
-- bound. RESERVED / SIGNED / BROADCASTING holds and SETTLED spends all live in the ZSET, so the
-- caller observes committed = SETTLED + outstanding holds — a settled spend stays counted, a
-- released hold is gone.
--
-- The fetch (ZRANGEBYSCORE then per-member HGET) runs atomically as one script, giving a
-- consistent snapshot. Summation is deliberately left to the caller, who adds the strings as
-- bigints: USDC base-unit totals can exceed 2^53, which Lua's double arithmetic would round.
--
-- KEYS[1] = spend-window ZSET
-- KEYS[2] = spend_amounts hash
-- ARGV[1] = minTs, inclusive lower bound (the QUOTED window snapshot)
-- returns a flat array of base-unit amount strings, one per in-window hold.

local members = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf')
local amounts = {}
for i = 1, #members do
  amounts[i] = redis.call('HGET', KEYS[2], members[i])
end
return amounts
