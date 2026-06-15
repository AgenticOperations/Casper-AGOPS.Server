-- reserve-with-policy.lua — atomic policy-checked hold writer.
--
-- Performs the cap/velocity check and the hold write in one Redis script. This closes the
-- read-then-reserve race where two concurrent authorizations can both observe the same window sum
-- before either hold is written.
--
-- KEYS[1..4] = spend-window ZSETs, in order 1h, 1d, 7d, 30d
-- KEYS[5]    = spend_amounts hash (paymentId -> base-unit amount)
-- KEYS[6]    = reserved counter
-- KEYS[7]    = reserved_holds set
-- ARGV[1]    = paymentId
-- ARGV[2]    = amount, base units
-- ARGV[3]    = enforcement timestamp
-- ARGV[4]    = 30d lower-bound timestamp
-- ARGV[5]    = spend cap, base units
-- ARGV[6]    = 1h lower-bound timestamp
-- ARGV[7]    = velocity limit per hour
-- returns 1 fresh reserve, 0 duplicate paymentId, -1 cap exceeded, -2 velocity exceeded.

local function normalize_decimal(s)
  s = tostring(s or '0')
  local stripped = string.gsub(s, '^0+', '')
  if stripped == '' then
    return '0'
  end
  return stripped
end

local function compare_decimal(a, b)
  a = normalize_decimal(a)
  b = normalize_decimal(b)
  if string.len(a) > string.len(b) then
    return 1
  end
  if string.len(a) < string.len(b) then
    return -1
  end
  if a > b then
    return 1
  end
  if a < b then
    return -1
  end
  return 0
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

local velocity = redis.call('ZCOUNT', KEYS[1], ARGV[6], '+inf')
if velocity >= tonumber(ARGV[7]) then
  return -2
end

local members = redis.call('ZRANGEBYSCORE', KEYS[4], ARGV[4], '+inf')
local total = '0'
for i = 1, #members do
  local amount = redis.call('HGET', KEYS[5], members[i])
  if amount then
    total = add_decimal(total, amount)
  end
end

if compare_decimal(add_decimal(total, ARGV[2]), ARGV[5]) == 1 then
  return -1
end

redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[2])
redis.call('SET', KEYS[6], add_decimal(redis.call('GET', KEYS[6]) or '0', ARGV[2]))
redis.call('SADD', KEYS[7], ARGV[1])
return 1
