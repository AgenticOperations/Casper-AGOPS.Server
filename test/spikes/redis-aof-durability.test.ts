import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { keys } from '../../src/redis/keyspace.js';

/**
 * SPIKE-06 (doc 04 §4, gate NFR-02): is a hold durable across a Redis restart, and
 * what does AOF (`appendfsync everysec`) cost the hot path?
 *
 * The hard assertion is durability: every acknowledged hold must still be present
 * after the store restarts. Latency (p50/p99 of a single hold write) is measured and
 * logged; the bound here is a loose CI sanity ceiling, not the calibrated budget —
 * the recorded numbers go into spike-results.md.
 */
const HOLD_COUNT = 100; // durability set
const LATENCY_SAMPLES = 500; // latency set
const AGENT = 'agt_spike06';
const LATENCY_CEILING_MS = 50; // generous: local Docker bridge overhead, not the real budget

let container: StartedTestContainer | undefined;
let dockerAvailable = true;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

async function startAofRedis(): Promise<StartedTestContainer> {
  return new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withCommand(['redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec'])
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}

function connect(c: StartedTestContainer): Redis {
  return new Redis({ host: c.getHost(), port: c.getMappedPort(6379), maxRetriesPerRequest: 3 });
}

beforeAll(async () => {
  try {
    container = await startAofRedis();
  } catch {
    dockerAvailable = false;
  }
});

afterAll(async () => {
  await container?.stop();
});

describe('SPIKE-06 — Redis AOF durability + hot-path write latency', () => {
  it('persists every acknowledged hold across a restart and stays within budget', async ({
    skip,
  }) => {
    if (!dockerAvailable || !container) return skip();

    let redis = connect(container);

    // 1) Write the durability set: hold-inclusive ZADD into the 1h spend window.
    const windowKey = keys.spendWindow(AGENT, '1h');
    const now = Date.now();
    for (let i = 0; i < HOLD_COUNT; i++) {
      const member = `pay_${i}`;
      // ZADD returns only once the command is acknowledged by the server.
      await redis.zadd(windowKey, now + i, member);
    }
    const beforeCount = await redis.zcard(windowKey);
    expect(beforeCount).toBe(HOLD_COUNT);

    // 2) Measure single-write latency (one ZADD round-trip = the unit hot-path write).
    const samples: number[] = [];
    for (let i = 0; i < LATENCY_SAMPLES; i++) {
      const t0 = performance.now();
      await redis.zadd(keys.reserved(AGENT), now + i, `r_${i}`);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p99 = percentile(samples, 99);
    // eslint-disable-next-line no-console
    console.log(
      `[SPIKE-06] AOF everysec single-write latency: p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms (n=${LATENCY_SAMPLES})`,
    );

    // 3) Let the everysec fsync window capture the writes, then restart the store.
    await new Promise((r) => setTimeout(r, 1200));
    await redis.quit();
    await container.restart();

    // 4) Reconnect and prove the holds survived.
    redis = connect(container);
    const afterCount = await redis.zcard(windowKey);
    // eslint-disable-next-line no-console
    console.log(`[SPIKE-06] holds before restart=${beforeCount}, after restart=${afterCount}`);
    expect(afterCount).toBe(HOLD_COUNT);
    await redis.quit();

    // Durability is the gate; latency is recorded with a loose CI ceiling.
    expect(p99).toBeLessThan(LATENCY_CEILING_MS);
  }, 180_000);
});
