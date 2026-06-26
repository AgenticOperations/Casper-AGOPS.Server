import { createHash } from 'node:crypto';

export interface LcpContext {
  termsUrl: string;
  atrHash: string | null;
  trustLevel: 1 | 2 | 3 | 4;
  fetchedAt: number;
  acceptanceRequired: boolean;
  hashVerified: boolean;
}

export type LcpDiscoverResult =
  | { ok: true; context: LcpContext }
  | { ok: false; reason: 'fetch_failed' | 'hash_mismatch' | 'parse_error' };

interface RawLcpDocument {
  terms?: unknown;
  atrHash?: unknown;
  acceptanceRequired?: unknown;
  trustLevel?: unknown;
}

export async function lcpDiscover(
  resourceId: string,
  options?: { timeoutMs?: number; fetchFn?: typeof fetch },
): Promise<LcpDiscoverResult> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3000;
  const fetchedAt = Math.floor(Date.now() / 1000);

  let origin: string;
  try {
    origin = new URL(resourceId).origin;
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }

  const lcpUrl = `${origin}/.well-known/legal-context.json`;

  let raw: RawLcpDocument;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchFn(lcpUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: 'fetch_failed' };
    raw = (await res.json()) as RawLcpDocument;
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }

  if (typeof raw.terms !== 'string') {
    return { ok: false, reason: 'parse_error' };
  }

  const termsUrl = raw.terms;
  const claimedAtrHash = typeof raw.atrHash === 'string' ? raw.atrHash : null;
  const acceptanceRequired = raw.acceptanceRequired === true;
  const rawTrustLevel = raw.trustLevel;
  const trustLevel: 1 | 2 | 3 | 4 =
    rawTrustLevel === 2 || rawTrustLevel === 3 || rawTrustLevel === 4 ? rawTrustLevel : 1;

  if (claimedAtrHash !== null) {
    let termsBody: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetchFn(termsUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, reason: 'fetch_failed' };
      termsBody = await res.text();
    } catch {
      return { ok: false, reason: 'fetch_failed' };
    }

    const computed = `sha256:${createHash('sha256').update(termsBody).digest('hex')}`;
    if (computed !== claimedAtrHash) {
      return { ok: false, reason: 'hash_mismatch' };
    }

    return {
      ok: true,
      context: {
        termsUrl,
        atrHash: claimedAtrHash,
        trustLevel: trustLevel === 1 ? 2 : trustLevel,
        fetchedAt,
        acceptanceRequired,
        hashVerified: true,
      },
    };
  }

  return {
    ok: true,
    context: {
      termsUrl,
      atrHash: null,
      trustLevel: 1,
      fetchedAt,
      acceptanceRequired,
      hashVerified: false,
    },
  };
}
