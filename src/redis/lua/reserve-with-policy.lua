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
-- KEYS[8]    = float_confirmed counter (the agent's on-chain-confirmed float)
-- KEYS[9]    = consumed counter (settled spend already drawn down from float)
-- ARGV[1]    = paymentId
-- ARGV[2]    = amount, base units
-- ARGV[3]    = enforcement timestamp
-- ARGV[4]    = 30d lower-bound timestamp
-- ARGV[5]    = spend cap, base units
-- ARGV[6]    = 1h lower-bound timestamp
-- ARGV[7]    = velocity limit per hour
-- ARGV[8]    = enforce_solvency: '1' to gate on real float, '0' to skip the check entirely
-- returns 1 fresh reserve, 0 duplicate paymentId, -1 cap exceeded, -2 velocity exceeded,
--         -3 insufficient float (the agent does not hold the money it is trying to spend).
--
-- SOLVENCY (ARGV[8]='1'): `spendCap` is a POLICY DIAL — an intent, "never spend more than this". It is
-- not money. Checking only the cap let an agent with ZERO confirmed float authorize payments and
-- receive paid data, because the guard's signature is what unlocks the vendor, and nothing on this
-- path ever read a balance. The solvency bound is custody truth:
--     spendable = float_confirmed - consumed - reserved
-- and it MUST be evaluated here, inside the same atomic script as the reserve. A check-then-reserve
-- split would let two concurrent authorizations both read the same spendable figure, both pass, and
-- together overspend the float — the same TOCTOU this script already closes for the cap.
--
-- `reserved` is read BEFORE this hold is written, so it counts only OTHER outstanding holds; the
-- current amount is added explicitly. Both ceilings apply and the tighter one wins.

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

-- Exact decimal subtraction (a - b), assuming a >= b. Mirrors add_decimal's string arithmetic so
-- motes totals above 2^53 stay exact — Lua doubles would silently round them.
local function sub_decimal(a, b)
  a = normalize_decimal(a)
  b = normalize_decimal(b)
  local borrow = 0
  local out = {}
  local ai = string.len(a)
  local bi = string.len(b)
  while ai > 0 do
    local da = tonumber(string.sub(a, ai, ai))
    local db = 0
    if bi > 0 then
      db = tonumber(string.sub(b, bi, bi))
      bi = bi - 1
    end
    local diff = da - db - borrow
    if diff < 0 then
      diff = diff + 10
      borrow = 1
    else
      borrow = 0
    end
    table.insert(out, 1, tostring(diff))
    ai = ai - 1
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

-- Solvency gate: the agent may only spend float it actually holds. Checked AFTER the policy cap so a
-- request breaching both is reported against the cap, and BEFORE any write so an insolvent request
-- reserves nothing and leaves no trace in the windows.
if ARGV[8] == '1' then
  local float_confirmed = normalize_decimal(redis.call('GET', KEYS[8]) or '0')
  local consumed = normalize_decimal(redis.call('GET', KEYS[9]) or '0')
  local reserved_now = normalize_decimal(redis.call('GET', KEYS[6]) or '0')

  -- drawn = consumed + other outstanding holds. Clamp at zero rather than trusting float >= drawn:
  -- a negative spendable must deny, and sub_decimal assumes a >= b.
  local drawn = add_decimal(consumed, reserved_now)
  if compare_decimal(drawn, float_confirmed) >= 0 then
    return -3
  end
  local spendable = sub_decimal(float_confirmed, drawn)
  if compare_decimal(ARGV[2], spendable) == 1 then
    return -3
  end
end

redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[2])
redis.call('SET', KEYS[6], add_decimal(redis.call('GET', KEYS[6]) or '0', ARGV[2]))
redis.call('SADD', KEYS[7], ARGV[1])
return 1
