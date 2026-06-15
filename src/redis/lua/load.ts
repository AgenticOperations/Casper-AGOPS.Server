import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Lua scripts are the source of truth for the hot tier's atomic, multi-key operations.
 *
 * They are read once at module load, relative to this file, so dev/test (tsx, vitest reading
 * `src/`) and production (`node dist/`) resolve them identically — the build copies the `.lua`
 * files into `dist/redis/lua/` (see `scripts/copy-lua.mjs`). They are registered on a client via
 * `defineCommand` so ioredis runs them through EVALSHA on the hot path.
 */
function loadLua(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

export const RESERVE_LUA = loadLua('reserve.lua');
export const RESERVE_WITH_POLICY_LUA = loadLua('reserve-with-policy.lua');
export const WINDOW_SUM_LUA = loadLua('window-sum.lua');
export const SETTLE_LUA = loadLua('settle.lua');
export const RELEASE_LUA = loadLua('release.lua');
export const EPOCH_BUMP_LUA = loadLua('epoch-bump.lua');
export const ALLOCATION_RESERVE_LUA = loadLua('allocation-reserve.lua');
export const CONFIRM_ALLOCATION_LUA = loadLua('confirm-allocation.lua');
export const CANCEL_ALLOCATION_LUA = loadLua('cancel-allocation.lua');
// Auth-route abuse control (P1i): fixed-window counter, not a hot-tier op but loaded the same way so
// the build's copy-lua step ships it to dist/redis/lua/ alongside the rest.
export const RATE_LIMIT_LUA = loadLua('rate-limit.lua');
