-- reserve.lua — atomic hold writer for the Ledger hot tier (engine-specs-FINAL.md:128).
--
-- Writes one hold across all spend windows + the amounts hash + the reserved counter,
-- all-or-nothing. The hold is hold-inclusive the instant this returns: it counts against every
-- window's cap before settlement (BUG-14). The same hold is mirrored into the reserved counter,
-- which Custody subtracts from spendable — same hold, two consumers, which is exactly why this
-- must be one atomic script.
--
-- Idempotent: a replay of the same paymentId is a no-op, so the reserved counter is never
-- double-bumped and the window sum never double-counts.
--
-- Phase-1 tradeoff: a settled hold's amount stays in spend_amounts (the window keeps counting it),
-- so settled entries are not pruned here and the per-agent spend_amounts / ZSETs grow over time.
-- window-sum stays correct (ZRANGEBYSCORE bounds by score, skipping out-of-window entries); a
-- sweeper that drops entries older than the widest (30d) window is deferred to the hardening pass.
--
-- KEYS[1..4] = spend-window ZSETs, in order 1h, 1d, 7d, 30d
-- KEYS[5]    = spend_amounts hash (paymentId -> base-unit amount)
-- KEYS[6]    = reserved counter
-- KEYS[7]    = reserved_holds set (paymentIds currently in the reserved counter)
-- ARGV[1]    = paymentId (ZSET member / hash field)
-- ARGV[2]    = amount, base units (decimal string; can exceed Redis int64)
-- ARGV[3]    = enforcement timestamp (ZSET score; the QUOTED snapshot)
-- returns 1 on a fresh reserve, 0 if the payment was already reserved.

local function normalize_decimal(s)
  s = tostring(s or '0')
  local stripped = string.gsub(s, '^0+', '')
  if stripped == '' then
    return '0'
  end
  return stripped
end

local function add_decimal(a, b)
  a = normalize_decimal(a)
  b = normalize_decimal(b)
  local carry = 0
  local out = {}
  local ai = string.len(a)
  local bi = string.len(b)
  while ai > 0 or bi > 0 or carry > 0 do
    local da = 0
    local db = 0
    if ai > 0 then
      da = tonumber(string.sub(a, ai, ai))
      ai = ai - 1
    end
    if bi > 0 then
      db = tonumber(string.sub(b, bi, bi))
      bi = bi - 1
    end
    local sum = da + db + carry
    table.insert(out, 1, tostring(sum % 10))
    carry = math.floor(sum / 10)
  end
  return normalize_decimal(table.concat(out, ''))
end

if redis.call('HEXISTS', KEYS[5], ARGV[1]) == 1 then
  return 0
end

redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[2])
redis.call('SET', KEYS[6], add_decimal(redis.call('GET', KEYS[6]) or '0', ARGV[2]))
redis.call('SADD', KEYS[7], ARGV[1])
return 1
