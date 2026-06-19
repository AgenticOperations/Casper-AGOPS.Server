import type { DomainRegistry } from '../../engines/identity/domain-binding.js';

/**
 * Network-backed E7 DomainRegistry (BUG-17) — the only place the spend-path recipient binding touches
 * the public internet. Fetches `https://{host}/.well-known/agentops.json` and returns the vendor's
 * published payment address. Hard 100ms timeout (the hot path never blocks longer); ANY failure —
 * timeout, non-200, bad shape, network error — resolves to null, which the caller treats as fail-closed
 * (`destination_unverified`). Read-only: agentOps signs only, never broadcasts.
 *
 * Sits with the other creds/network seam impls (`src/lib/arc`, `src/lib/circle`); plugged into the hot
 * path alongside the signer + chain seams when the full `hotPath` is configured (deferred, like the
 * viem `tokenDomainSource`). Negative-result caching (anti fetch-storm) is a deferred harden item —
 * today the verifier caches only positive resolutions.
 */

const WELL_KNOWN_PATH = '/.well-known/agentops.json';
const FETCH_TIMEOUT_MS = 100;

export function wellKnownDomainRegistry(): DomainRegistry {
  return {
    async resolvePaymentAddress(host: string): Promise<string | null> {
      if (host.length === 0) return null;
      try {
        const res = await fetch(`https://${host}${WELL_KNOWN_PATH}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: 'application/json' },
        });
        if (!res.ok) return null;
        const body: unknown = await res.json();
        const addr = (body as { payment_address?: unknown }).payment_address;
        return typeof addr === 'string' && addr.length > 0 ? addr : null;
      } catch {
        return null; // timeout / network / parse — fail-closed.
      }
    },
  };
}
