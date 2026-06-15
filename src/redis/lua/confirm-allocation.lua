-- Two-phase float promotion + budget commit, SINGLE-WINNER (BUG-29/39/42).
-- KEYS[1] allocation hash · KEYS[2] float_pending · KEYS[3] float_confirmed
-- KEYS[4] allocation_reserved · KEYS[5] allocation_committed
-- ARGV[1] amount (base units)
-- Returns 1 if THIS call performed the promotion, 0 if already promoted / absent (NOOP). The state
-- check + the four counter moves are one atomic step, so concurrent confirmers cannot double-promote.
if redis.call('HGET', KEYS[1], 'state') ~= 'PENDING' then
  return 0
end
redis.call('HSET', KEYS[1], 'state', 'CONFIRMED')
redis.call('DECRBY', KEYS[2], ARGV[1])
redis.call('INCRBY', KEYS[3], ARGV[1])
redis.call('DECRBY', KEYS[4], ARGV[1])
redis.call('INCRBY', KEYS[5], ARGV[1])
return 1
