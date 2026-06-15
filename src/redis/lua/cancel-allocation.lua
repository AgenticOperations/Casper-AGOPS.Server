-- Cancel a still-pending allocation during teardown, SINGLE-WINNER (E5/L5, BUG-21, SPIKE-03).
-- KEYS[1] allocation hash · KEYS[2] float_pending · KEYS[3] allocation_reserved
-- KEYS[4] pending_allocations set
-- ARGV[1] amount (base units) · ARGV[2] allocationId (set member)
-- Returns 1 if THIS call cancelled it, 0 if it was already terminal (promoted/cancelled) — NOOP. The
-- state check, the two counter releases, the set removal, and the record delete are one atomic step, so a
-- concurrent confirmer and a teardown sweep cannot both act on the same deposit (mirrors confirm-allocation).
if redis.call('HGET', KEYS[1], 'state') ~= 'PENDING' then
  return 0
end
redis.call('DECRBY', KEYS[2], ARGV[1])
redis.call('DECRBY', KEYS[3], ARGV[1])
redis.call('SREM', KEYS[4], ARGV[2])
redis.call('DEL', KEYS[1])
return 1
