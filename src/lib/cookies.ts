/**
 * Minimal cookie parse/serialize — kept dependency-free (no @fastify/cookie) to match the codebase's
 * plain-route, no-plugin posture. Only the small surface we need: read cookies, build a Set-Cookie.
 *
 * Forward-compat for P1h (Google OAuth): the SERIALIZERS return a plain string so a caller can set
 * MULTIPLE Set-Cookie headers at once via `reply.header('set-cookie', [a, b])`. Fastify replaces a
 * repeated single-string set-cookie, so the OAuth callback (which may set a session cookie AND clear a
 * short-lived oauth-state cookie in one response) must pass an array of these serialized strings. The
 * route-level `setSessionCookie(reply, …)` helper composes `serializeSessionCookie(…)` internally, so
 * that path needs no refactor when P1h lands.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  domain?: string;
  expires?: Date;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAgeSeconds !== undefined) segments.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  if (opts.expires) segments.push(`Expires=${opts.expires.toUTCString()}`);
  segments.push(`Path=${opts.path ?? '/'}`);
  if (opts.domain) segments.push(`Domain=${opts.domain}`);
  if (opts.httpOnly !== false) segments.push('HttpOnly');
  if (opts.secure) segments.push('Secure');
  segments.push(`SameSite=${(opts.sameSite ?? 'lax').replace(/^./, (c) => c.toUpperCase())}`);
  return segments.join('; ');
}

/** Shape of the session-cookie policy a caller derives from env (name + secure flag + optional domain). */
export interface SessionCookiePolicy {
  name: string;
  secure: boolean;
  domain?: string;
  maxAgeSeconds: number;
}

/**
 * Serialize the live session Set-Cookie string (httpOnly, sameSite=lax, path=/). Returned as a plain
 * string so it can be combined with other Set-Cookie strings into an array (P1h OAuth callback).
 */
export function serializeSessionCookie(
  token: string,
  policy: SessionCookiePolicy,
): string {
  return serializeCookie(policy.name, token, {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'lax',
    path: '/',
    maxAgeSeconds: policy.maxAgeSeconds,
    ...(policy.domain ? { domain: policy.domain } : {}),
  });
}

/** Serialize the cookie that CLEARS the session (Max-Age=0, same attributes so the browser drops it). */
export function serializeClearSessionCookie(policy: Omit<SessionCookiePolicy, 'maxAgeSeconds'>): string {
  return serializeCookie(policy.name, '', {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'lax',
    path: '/',
    maxAgeSeconds: 0,
    ...(policy.domain ? { domain: policy.domain } : {}),
  });
}
