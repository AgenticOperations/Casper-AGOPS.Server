-- release.lua — drop a hold on FAILED_TERMINAL / EXPIRED (engine-specs-FINAL.md:153).
--
-- The payment never happened, so the hold is removed from window accounting entirely (ZREM from
-- every window + HDEL its amount) and, if it is still outstanding-reserved, the reserved counter
-- drops. The FSM only releases from non-settled states, so this never un-counts a settled spend.
--
-- Idempotent: a second release finds no amount and is a no-op; the reserved counter is decremented
-- at most once and never goes negative.
--
-- Defense-in-depth: if the paymentId is already SETTLED, refuse — a settled spend must stay counted
-- in its window (BUG-14). The FSM never releases a settled payment, but the money layer does not
-- rely on that discipline alone.
--
-- KEYS[1..4] = spend-window ZSETs, in order 1h, 1d, 7d, 30d
-- KEYS[5]    = spend_amounts hash
-- KEYS[6]    = reserved counter
-- KEYS[7]    = reserved_holds set
-- KEYS[8]    = settled_holds set
-- ARGV[1]    = paymentId
-- returns 1 if a hold was removed, 0 if there was nothing to release (or it was already settled).

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

if redis.call('SISMEMBER', KEYS[8], ARGV[1]) == 1 then
  return 0
end

local amount = redis.call('HGET', KEYS[5], ARGV[1])
if not amount then
  return 0
end

redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HDEL', KEYS[5], ARGV[1])

if redis.call('SISMEMBER', KEYS[7], ARGV[1]) == 1 then
  redis.call('SREM', KEYS[7], ARGV[1])
  redis.call('SET', KEYS[6], subtract_decimal(redis.call('GET', KEYS[6]) or '0', amount))
end

return 1
