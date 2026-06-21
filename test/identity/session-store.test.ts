import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startIdStores, stopIdStores, type IdStores } from '../helpers/identity-harness.js';
import {
  createSession,
  resolveSession,
  revokeSession,
  SESSION_TTL_MS,
} from '../../src/engines/identity/account/session-store.js';
import { createUser } from '../../src/engines/identity/account/user-store.js';

/**
 * Resolver branch coverage for the session store: resolveSession() must yield null for any session
 * that is expired (expires_at in the past) or revoked (revoked_at set) — the two non-happy branches of
 * its WHERE clause. A live session is the control.
 */
let stores: IdStores | null = null;
beforeAll(async () => {
  stores = await startIdStores();
}, 180_000);
afterAll(async () => {
  await stopIdStores(stores);
});

/** Mint a throwaway user to satisfy the sessions.user_id FK. */
async function freshUserId(s: IdStores, email: string): Promise<string> {
  const u = await createUser(s.pool, { email, passwordHash: null });
  return u.id;
}

describe('session-store resolveSession — branch coverage', () => {
  it('resolves a live session to its user id (control)', async ({ skip }) => {
    if (!stores) return skip();
    const userId = await freshUserId(stores, 'live-session@test.com');
    const { token } = await createSession(stores.pool, userId);
    expect(await resolveSession(stores.pool, token)).toEqual({ userId });
  });

  it('resolves a session whose expires_at is in the past to null', async ({ skip }) => {
    if (!stores) return skip();
    const userId = await freshUserId(stores, 'expired-session@test.com');
    // now in the past so expires_at = now + TTL lands ~1 minute BEFORE the DB clock.
    const pastNow = Date.now() - SESSION_TTL_MS - 60_000;
    const { token } = await createSession(stores.pool, userId, pastNow);
    expect(await resolveSession(stores.pool, token)).toBeNull();
  });

  it('resolves a revoked session (revoked_at set) to null', async ({ skip }) => {
    if (!stores) return skip();
    const userId = await freshUserId(stores, 'revoked-session@test.com');
    const { token } = await createSession(stores.pool, userId);
    // Sanity: live before revoke.
    expect(await resolveSession(stores.pool, token)).toEqual({ userId });
    await revokeSession(stores.pool, token);
    expect(await resolveSession(stores.pool, token)).toBeNull();
  });
});
