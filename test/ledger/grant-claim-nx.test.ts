import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { claimGrant } from '../../src/engines/ledger/grant.js';

/**
 * Thesis: grant claim is set-if-not-exists on (paymentId, resourceId) — the global dedup store.
 * A delivered resource is claimed exactly once; a replay of the same payment for the same resource
 * is rejected. (The full enforcement anchor — claim before deliver — lands in M5; this is the
 * atomic primitive it builds on.)
 *
 * Requires Docker; skips when no container runtime is available.
 */

let container: StartedTestContainer | undefined;
let redis: Redis | undefined;
let dockerAvailable = true;

beforeAll(async () => {
  try {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: 3,
    });
  } catch {
    dockerAvailable = false;
  }
}, 180_000);

afterAll(async () => {
  await redis?.quit();
  await container?.stop();
});

describe('grant-dedup NX primitive', () => {
  it('claims once and rejects a replay of the same (payment, resource)', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();

    const first = await claimGrant(redis, 'pay_g1', 'res_a', 60);
    expect(first).toBe(true); // fresh claim wins

    const replay = await claimGrant(redis, 'pay_g1', 'res_a', 60);
    expect(replay).toBe(false); // same pair already claimed

    // A different resource for the same payment is an independent claim.
    const other = await claimGrant(redis, 'pay_g1', 'res_b', 60);
    expect(other).toBe(true);
  });
});
