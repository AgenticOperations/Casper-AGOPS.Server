import type pg from 'pg';
import { newOAuthAccountId } from '../../../lib/ids.js';
import { createUser, findUserByEmail, type UserRecord } from './user-store.js';

/**
 * Resolve a Google profile to a local user, creating or linking the oauth_accounts row on sign-in.
 *
 * Resolution order (security-critical — see the account-takeover guard below):
 *   1. EXISTING LINK — an oauth_accounts row for (provider, providerAccountId) already maps to a user →
 *      return that user (returning sign-in; no new rows). This is keyed on Google's stable `sub`.
 *   2. EXISTING EMAIL — a local user already owns this email (e.g. a password account):
 *        - LINK to it ONLY when Google asserts `emailVerified === true`. Google's verified email then
 *          also upgrades the local user's email_verified flag.
 *        - REFUSE to link when Google's email is UNVERIFIED. Auto-linking an unverified Google email to
 *          an existing (possibly password) account is account takeover: an attacker who creates a Google
 *          account claiming victim@example.com (without proving control) would otherwise seize the
 *          victim's account. We fail closed — no link, no new user — and the route answers 403.
 *   3. NEW USER — no link and no existing email → create a fresh OAuth-only user (password_hash NULL),
 *      seeding email_verified from Google, and link it.
 *
 * The return is a discriminated union so the caller can fail closed on the takeover branch without a
 * thrown control-flow exception leaking into the 5xx path.
 */
export type UpsertOAuthResult =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: 'email_unverified_conflict' };

export async function upsertOAuthUser(
  pool: pg.Pool,
  params: {
    provider: 'google';
    providerAccountId: string;
    email: string;
    emailVerified: boolean;
    name: string;
  },
): Promise<UpsertOAuthResult> {
  // (1) Returning user: the (provider, provider_account_id) link already exists → reuse that user.
  const existingLink = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2',
    [params.provider, params.providerAccountId],
  );
  if (existingLink.rows[0]) {
    const u = await pool.query<{
      id: string;
      email: string;
      password_hash: string | null;
      email_verified: boolean;
      name: string;
    }>('SELECT id, email, password_hash, email_verified, name FROM users WHERE id = $1', [
      existingLink.rows[0].user_id,
    ]);
    const r = u.rows[0];
    if (!r) throw new Error('upsertOAuthUser: oauth link references a missing user');
    return {
      ok: true,
      user: {
        id: r.id,
        email: r.email,
        passwordHash: r.password_hash,
        emailVerified: r.email_verified,
        name: r.name,
      },
    };
  }

  // (2) An account with this email already exists.
  const existingByEmail = await findUserByEmail(pool, params.email);
  if (existingByEmail) {
    // ACCOUNT-TAKEOVER GUARD: only link an existing-email account when Google asserts the email is
    // verified. Require a STRICT boolean `true` (matching the documented `=== true` contract) so any
    // non-boolean that leaked past the boundary cannot read as truthy. Fail closed otherwise.
    if (params.emailVerified !== true) {
      return { ok: false, reason: 'email_unverified_conflict' };
    }
    // Verified Google email may link, and upgrades the local email_verified flag if it was false.
    if (!existingByEmail.emailVerified) {
      await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [existingByEmail.id]);
    }
    await pool.query(
      'INSERT INTO oauth_accounts (id, provider, provider_account_id, user_id) VALUES ($1,$2,$3,$4)',
      [newOAuthAccountId(), params.provider, params.providerAccountId, existingByEmail.id],
    );
    return { ok: true, user: { ...existingByEmail, emailVerified: true } };
  }

  // (3) Brand-new identity: create an OAuth-only user (no password) and link it.
  const user = await createUser(pool, {
    email: params.email,
    passwordHash: null,
    name: params.name,
    emailVerified: params.emailVerified,
  });
  await pool.query(
    'INSERT INTO oauth_accounts (id, provider, provider_account_id, user_id) VALUES ($1,$2,$3,$4)',
    [newOAuthAccountId(), params.provider, params.providerAccountId, user.id],
  );
  return { ok: true, user };
}
