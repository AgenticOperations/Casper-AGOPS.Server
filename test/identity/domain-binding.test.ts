import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { verifyDomainBinding, type DomainRegistry } from '../../src/engines/identity/domain-binding.js';
import { keys } from '../../src/redis/keyspace.js';
import { startStores, stopStores, type Stores } from '../helpers/oracle-harness.js';

/**
 * E7 Domain Binding Verifier (policy-engine-FINAL.md:282, BUG-17). The 402's payTo MUST match the
 * address the vendor domain publishes at .well-known/agentops.json. ServiceScope (P3-A) already bounds
 * WHICH domain may be paid; this binds the payTo TO that domain, closing the spend-path recipient gap.
 *
 * Fail-closed: an unverifiable or mismatched destination is DENIED (destination_unverified). A positive
 * domain record is cached 5 min; a failure/mismatch is never cached, so a transient registry outage
 * self-heals on the next request and never silently widens who an agent may pay.
 *
 * Requires Docker; skips when no container runtime is available.
 */

const HOST = 'api.vendor.test';
const REGISTERED = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa';

let stores: Stores | null = null;
let redis: Redis;

beforeAll(async () => {
  stores = await startStores();
  if (stores) redis = stores.redis;
}, 180_000);

afterAll(async () => {
  await stopStores(stores);
});

beforeEach(async () => {
  if (stores) await redis.flushdb();
});

/** A registry that records every host queried and publishes REGISTERED only for HOST. */
function registryRecording(seen: string[]): DomainRegistry {
  return {
    resolvePaymentAddress: (host) => {
      seen.push(host);
      return Promise.resolve(host === HOST ? REGISTERED : null);
    },
  };
}

describe('verifyDomainBinding — E7 recipient binding (BUG-17)', () => {
  it('binds a payTo that matches the published address (case-insensitive) via one cold fetch', async ({
    skip,
  }) => {
    if (!stores) return skip();
    const seen: string[] = [];
    const r = await verifyDomainBinding(redis, registryRecording(seen), {
      host: HOST,
      payTo: REGISTERED.toLowerCase(),
    });
    expect(r.bound).toBe(true);
    expect(seen).toEqual([HOST]); // exactly one cold fetch
  });

  it('serves the second lookup from the 5-min cache without a second fetch', async ({ skip }) => {
    if (!stores) return skip();
    const seen: string[] = [];
    const reg = registryRecording(seen);
    await verifyDomainBinding(redis, reg, { host: HOST, payTo: REGISTERED });
    await verifyDomainBinding(redis, reg, { host: HOST, payTo: REGISTERED });
    expect(seen.length).toBe(1);
    expect(await redis.ttl(keys.domainBinding(HOST))).toBeGreaterThan(0);
  });

  it('DENIES (fail-closed) a payTo that does not match the published address', async ({ skip }) => {
    if (!stores) return skip();
    const r = await verifyDomainBinding(redis, registryRecording([]), {
      host: HOST,
      payTo: '0xbeef000000000000000000000000000000000000',
    });
    expect(r).toEqual({ bound: false, reason: 'destination_unverified' });
  });

  it('DENIES when the registry returns null and does NOT cache the negative', async ({ skip }) => {
    if (!stores) return skip();
    const r = await verifyDomainBinding(redis, registryRecording([]), {
      host: 'unknown.test',
      payTo: REGISTERED,
    });
    expect(r).toEqual({ bound: false, reason: 'destination_unverified' });
    expect(await redis.get(keys.domainBinding('unknown.test'))).toBeNull();
  });

  it('DENIES an empty host or payTo without querying the registry', async ({ skip }) => {
    if (!stores) return skip();
    const seen: string[] = [];
    const reg = registryRecording(seen);
    expect((await verifyDomainBinding(redis, reg, { host: '', payTo: REGISTERED })).bound).toBe(false);
    expect((await verifyDomainBinding(redis, reg, { host: HOST, payTo: '' })).bound).toBe(false);
    expect(seen.length).toBe(0);
  });
});
