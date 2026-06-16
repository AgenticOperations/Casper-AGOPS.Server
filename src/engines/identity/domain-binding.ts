import type { Redis } from 'ioredis';
import type { DenyReason } from '../../contracts/index.js';
import { keys } from '../../redis/keyspace.js';

/**
 * E7 Domain Binding Verifier (policy-engine-FINAL.md:282, BUG-17). Closes the spend-path recipient
 * gap: agentOps independently confirms the 402's payTo matches the address the vendor domain publishes
 * at https://{host}/.well-known/agentops.json, so a compromised agent cannot redirect a policy-valid
 * spend to an attacker address. ServiceScope (P3-A) already bounds WHICH domain may be paid; this binds
 * the payTo TO that domain. Fail-closed: an unverifiable destination is DENIED (destination_unverified).
 *
 * The hot path reads a 5-min Redis cache; a cold miss does one bounded (100ms) registry fetch whose
 * timeout lives in the network-backed impl ({@link import('../../lib/identity/well-known-registry.js')}).
 * A positive domain record is cached; a failure/timeout/mismatch is NOT cached, so a transient outage
 * self-heals on the next request and never silently widens the recipient set.
 */

const DOMAIN_BINDING_TTL_SECONDS = 5 * 60;

export interface DomainRegistry {
  /**
   * Resolve the vendor's published payment address for `host` (the .well-known/agentops.json fetch).
   * MUST enforce a hard 100ms timeout and return null on timeout / fetch failure / absent record —
   * the caller treats null as fail-closed. Should not throw (a throw is still handled fail-closed).
   */
  resolvePaymentAddress(host: string): Promise<string | null>;
}

export type BindingResult =
  | { bound: true }
  | { bound: false; reason: Extract<DenyReason, 'destination_unverified'> };

const UNVERIFIED: BindingResult = { bound: false, reason: 'destination_unverified' };

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function verifyDomainBinding(
  redis: Redis,
  registry: DomainRegistry,
  params: { host: string; payTo: string },
): Promise<BindingResult> {
  const { host, payTo } = params;
  if (host.length === 0 || payTo.length === 0) return UNVERIFIED;

  const cacheKey = keys.domainBinding(host);
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return sameAddress(cached, payTo) ? { bound: true } : UNVERIFIED;
  }

  let registered: string | null;
  try {
    registered = await registry.resolvePaymentAddress(host);
  } catch {
    return UNVERIFIED; // defense-in-depth: a throwing impl is still fail-closed.
  }
  if (registered === null || registered.length === 0) return UNVERIFIED;

  // Cache the DOMAIN's published address (a property of the domain), then compare per-request.
  await redis.set(cacheKey, registered.toLowerCase(), 'EX', DOMAIN_BINDING_TTL_SECONDS);
  return sameAddress(registered, payTo) ? { bound: true } : UNVERIFIED;
}
