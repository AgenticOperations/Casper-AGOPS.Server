-- settle.lua — convert a hold in place on SETTLED (engine-specs-FINAL.md:153).
--
-- The spend is real, so it STAYS counted in every spend window (committed = SETTLED + outstanding
-- holds, BUG-14): the ZSET entries and the amount hash are deliberately left untouched. It is no
-- longer outstanding-reserved, so it leaves the reserved_holds set and the reserved counter drops.
--
-- Idempotent: the reserved counter is decremented exactly once. A second settle finds the payment
-- already cleared from reserved_holds and is a no-op. The paymentId is added to settled_holds so
-- a later release can never un-count this now-settled spend (defense-in-depth, release.lua).
--
-- KEYS[1] = reserved counter
-- KEYS[2] = reserved_holds set
-- KEYS[3] = spend_amounts hash
-- KEYS[4] = settled_holds set
-- ARGV[1] = paymentId
-- returns 1 if this call cleared the reserved contribution, 0 if it was already settled/released.

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

local function subtract_decimal(a, b)
  a = normalize_decimal(a)
  b = normalize_decimal(b)
  if compare_decimal(a, b) <= 0 then
    return '0'
  end
  local borrow = 0
  local out = {}
  local ai = string.len(a)
  local bi = string.len(b)
  while ai > 0 do
    local da = tonumber(string.sub(a, ai, ai)) - borrow
    local db = 0
    if bi > 0 then
      db = tonumber(string.sub(b, bi, bi))
      bi = bi - 1
    end
    if da < db then
      da = da + 10
      borrow = 1
    else
      borrow = 0
    end
    table.insert(out, 1, tostring(da - db))
    ai = ai - 1
  end
  return normalize_decimal(table.concat(out, ''))
end

if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 0 then
  return 0
end

local amount = redis.call('HGET', KEYS[3], ARGV[1])
if not amount then
  -- Defensive: reserved_holds and spend_amounts should move together; resync if they ever diverge.
  redis.call('SREM', KEYS[2], ARGV[1])
  return 0
end

redis.call('SREM', KEYS[2], ARGV[1])
redis.call('SET', KEYS[1], subtract_decimal(redis.call('GET', KEYS[1]) or '0', amount))
redis.call('SADD', KEYS[4], ARGV[1])
return 1
