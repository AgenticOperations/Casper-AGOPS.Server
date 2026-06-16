import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Env } from '../../../config/env.js';

/**
 * Google OIDC authorization-code flow over plain `fetch` (no heavy OAuth lib). Credential-gated: if any of
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URL is empty the feature reports
 * `configured:false` and the routes answer "not configured" (HTTP 501) instead of crashing —
 * email+password auth is entirely unaffected. CSRF is defended with an opaque `state`: the route pins it
 * in a short-lived httpOnly cookie at `start` and re-checks it on `callback`.
 *
 * The `GoogleClient` is the INJECTABLE seam (see {@link createGoogleClient}'s `fetchImpl` parameter, and
 * `AppDeps.googleOAuth`): tests pass a fake client so no network call is ever made. The live client never
 * logs the client_secret, the authorization `code`, or any token — only opaque error codes derived from
 * the HTTP status surface in thrown errors.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}

/** The verified subset of the Google profile we persist/act on. `sub` is the stable account id. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleClient {
  configured: boolean;
  /** Authorization URL the browser is redirected to (CSRF `state` baked in). */
  authUrl(state: string): string;
  /** Exchange the code for tokens and resolve the verified profile. Throws on any Google error. */
  exchange(code: string): Promise<GoogleProfile>;
}

/** Build a GoogleConfig from env, or null when any required credential is missing (→ feature disabled). */
export function googleConfigFromEnv(env: Env): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URL) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUrl: env.GOOGLE_OAUTH_REDIRECT_URL,
  };
}

/**
 * Opaque CSRF state token. `randomBytes` (CSPRNG) gives 192 bits of entropy. The plaintext is sent to
 * Google AND pinned in the state cookie; the callback compares the two in constant time (see oauth-routes).
 */
export function newOAuthState(): string {
  return randomBytes(24).toString('hex');
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Strict schema for the RAW Google OIDC userinfo body. `email_verified` is the security-critical field:
 * Google has historically returned it as a STRING ("false"/"true") rather than a JSON boolean. We accept
 * the loose wire shape (boolean OR string OR absent) and then coerce to a REAL boolean that is true ONLY
 * for boolean `true` — the string "true" is NOT honored. A truthy non-boolean ("false") flowing through
 * unchecked would let an unverified Google email auto-link to an existing account (account takeover).
 */
const userinfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.union([z.boolean(), z.string()]).optional(),
  name: z.string().optional(),
});

/** Live client backed by global `fetch`. `fetchImpl` is injectable so tests fake Google with no network. */
export function createGoogleClient(
  cfg: GoogleConfig | null,
  fetchImpl: typeof fetch = fetch,
): GoogleClient {
  if (!cfg) {
    return {
      configured: false,
      authUrl: () => {
        throw new Error('google_oauth_not_configured');
      },
      exchange: () => Promise.reject(new Error('google_oauth_not_configured')),
    };
  }
  return {
    configured: true,
    authUrl(state: string): string {
      const p = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUrl,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
      });
      return `${AUTH_ENDPOINT}?${p.toString()}`;
    },
    async exchange(code: string): Promise<GoogleProfile> {
      // Token exchange: POST the authorization code. Never log the body — it carries the client_secret
      // and the one-time code. A non-2xx surfaces only the numeric status, never the response body.
      const tokenRes = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUrl,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!tokenRes.ok) throw new Error(`google_token_exchange_failed_${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as { access_token?: string };
      if (!tokens.access_token) throw new Error('google_token_missing');

      // Userinfo: the access token never touches a log line (it lives only in this Authorization header).
      const infoRes = await fetchImpl(USERINFO_ENDPOINT, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (!infoRes.ok) throw new Error(`google_userinfo_failed_${infoRes.status}`);
      const parsed = userinfoSchema.safeParse(await infoRes.json());
      if (!parsed.success) throw new Error('google_profile_incomplete');
      const info = parsed.data;
      return {
        sub: info.sub,
        email: info.email,
        // STRICT: verified iff the wire value is the boolean `true`. A string ("false" — historically
        // truthy — or even "true") is NEVER treated as verified. This is the takeover boundary.
        emailVerified: info.email_verified === true,
        name: info.name ?? '',
      };
    },
  };
}

/** sha256 hex of a value — used to compare CSRF states without leaking length/content via early-exit. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
