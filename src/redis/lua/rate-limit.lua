-- rate-limit.lua — fixed-window request counter for auth-route abuse control (P1i).
--
-- One counter per (route-group, identifier) key. INCR returns the request's position in the current
-- window; EXPIRE is armed ONLY on the first increment (current == 1) so the TTL marks the window edge
-- and the window does NOT slide forward on every hit (a fixed window, not a sliding one). A hit beyond
-- the limit is rejected but the counter still advances — the window only resets when the TTL lapses.
--
-- KEYS[1] = counter key (e.g. ratelimit:auth:login:203.0.113.7)
-- ARGV[1] = limit (max requests per window)
-- ARGV[2] = window seconds
-- returns { allowed (1 = permit / 0 = throttle), remaining (>=0), ttl (seconds to window reset) }

local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
local ttl = redis.call('TTL', KEYS[1])
local limit = tonumber(ARGV[1])
if current > limit then
  return { 0, 0, ttl }
end
return { 1, limit - current, ttl }
