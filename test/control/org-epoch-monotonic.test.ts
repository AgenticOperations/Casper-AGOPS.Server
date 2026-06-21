import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { bumpOrgEpoch, readOrgEpoch } from '../../src/engines/control/epoch.js';

/**
 * Thesis (NFR-03, PHASE-1-NFR-CHECKLIST.md:35-40): the per-org `policy_epoch` counter the hot path
 * compares against is MONOTONIC — it advances on a newer epoch and never regresses. Postgres
 * assigns epochs monotonically under `FOR UPDATE`, but the Redis mirror write lands after COMMIT,
 * outside that lock, so two edits can race the mirror writes out of order. A counter that regressed
 * would let a stale blob pass the guard and overspend, so the bump is `set-if-greater`.
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

describe('per-org policy epoch counter is monotonic (NFR-03)', () => {
  it('advances on a newer epoch and never regresses', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    const org = 'org_epoch_mono';

    // Unknown org → null (the guard treats this as "current unknown" and recompiles).
    expect(await readOrgEpoch(redis, org)).toBe(null);

    // First edit: 0 -> 1 advances.
    expect(await bumpOrgEpoch(redis, org, 1)).toBe(true);
    expect(await readOrgEpoch(redis, org)).toBe(1);

    // Replay of the same epoch does not advance (idempotent).
    expect(await bumpOrgEpoch(redis, org, 1)).toBe(false);
    expect(await readOrgEpoch(redis, org)).toBe(1);

    // A higher epoch advances.
    expect(await bumpOrgEpoch(redis, org, 3)).toBe(true);
    expect(await readOrgEpoch(redis, org)).toBe(3);

    // An out-of-order LOWER epoch is refused; the counter holds at the high-water mark.
    expect(await bumpOrgEpoch(redis, org, 2)).toBe(false);
    expect(await readOrgEpoch(redis, org)).toBe(3);
  });

  it('keeps separate high-water marks per org', async ({ skip }) => {
    if (!dockerAvailable || !redis) return skip();
    await bumpOrgEpoch(redis, 'org_a', 5);
    await bumpOrgEpoch(redis, 'org_b', 2);
    expect(await readOrgEpoch(redis, 'org_a')).toBe(5);
    expect(await readOrgEpoch(redis, 'org_b')).toBe(2);
  });
});
