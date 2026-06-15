-- epoch-bump.lua — monotonic per-org policy-epoch counter for the NFR-03 stale-cache guard.
--
-- The hot path (P3-A) compares an effective_policy blob's epoch against this counter to detect a
-- stale cache. Postgres assigns org epochs monotonically under FOR UPDATE, but the Redis mirror
-- write happens after COMMIT, outside that lock, so two committed edits can race their mirror
-- writes out of order. This makes the counter a high-water mark: it advances to a strictly newer
-- epoch and NEVER regresses, so a late lower write can't drop the current epoch and let a stale
-- blob pass the guard (a money-correctness invariant — a regressed epoch means overspend).
--
-- KEYS[1] = org:{id}:policy_epoch counter
-- ARGV[1] = candidate epoch (integer)
-- returns 1 if the counter advanced to ARGV[1], 0 if the candidate was not greater (no-op).

local current = redis.call('GET', KEYS[1])
if current == false or tonumber(ARGV[1]) > tonumber(current) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
