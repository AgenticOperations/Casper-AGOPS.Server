import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { emitDecisionSafe } from '../../src/engines/monitoring/telemetry.js';
import {
  startStores,
  stopStores,
  buildOracleApp,
  seedAgent,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * F4.A1 — SSE snapshot carries id: frames and supports Last-Event-ID resume.
 * F4.A2 — follow=1 live push tail + teardown.
 * Requires Docker/Testcontainers; skips cleanly when none is available.
 */

let stores: Stores | null = null;
let app: FastifyInstance | undefined;
let adminKey: string;
let orgId: string;
let agentId: string;
let redis: Redis | undefined;

beforeAll(async () => {
  stores = await startStores();
  if (!stores) return;
  redis = stores.redis;
  app = buildOracleApp(stores.pool, stores.redis);
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  ({ orgId, agentId, adminKey } = await seedAgent(stores.pool, stores.redis, 10));
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

describe('GET /v1/monitoring/decisions/stream (snapshot + resume)', () => {
  it('emits one id-tagged data frame per decision, oldest first', async ({ skip }) => {
    if (!stores || !app) return skip();

    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_1',
      agentId: 'agt_x',
      orgId,
      outcome: 'ALLOW',
      railScheme: 'raw-x402',
      railChain: 'arc',
      resourceId: 'svc:weather',
      amount: '1000000',
      ts: 1,
    });
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_2',
      agentId: 'agt_x',
      orgId,
      outcome: 'DENY',
      reason: 'spend_cap_exceeded',
      railScheme: 'raw-x402',
      railChain: 'arc',
      resourceId: 'svc:weather',
      amount: '2000000',
      ts: 2,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions/stream',
      headers: { authorization: `Bearer ${adminKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    // Split on double newline; filter out empty trailing entries.
    const frames = res.body.split('\n\n').filter((f) => f.length > 0);
    expect(frames).toHaveLength(2);

    // Each frame must start with "id: <something>\ndata: "
    for (const f of frames) {
      expect(f).toMatch(/^id: .+\ndata: /);
    }

    // Oldest first: pay_1 in frame[0], pay_2 in frame[1]
    expect(frames[0]).toContain('pay_1');
    expect(frames[1]).toContain('pay_2');
  });

  it('resumes after Last-Event-ID without replaying earlier entries', async ({ skip }) => {
    if (!stores || !app) return skip();

    // Read the current snapshot to extract the first frame's id.
    const snapshot = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions/stream',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(snapshot.statusCode).toBe(200);

    const firstFrame = snapshot.body.split('\n\n').find((f) => f.length > 0) ?? '';
    const match = firstFrame.match(/^id: (.+)/);
    expect(match).not.toBeNull();
    const firstId = match![1] as string;

    // Resume from firstId — should NOT include pay_1, SHOULD include pay_2.
    const resumed = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions/stream',
      headers: {
        authorization: `Bearer ${adminKey}`,
        'last-event-id': firstId,
      },
    });
    expect(resumed.statusCode).toBe(200);

    const resumedFrames = resumed.body.split('\n\n').filter((f) => f.length > 0);
    const allResumedBody = resumedFrames.join('\n\n');

    expect(allResumedBody).not.toContain('pay_1');
    expect(resumedFrames.length).toBeGreaterThanOrEqual(1);
    expect(allResumedBody).toContain('pay_2');
  });

  it('rejects an unauthenticated stream request', async ({ skip }) => {
    if (!stores || !app) return skip();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/monitoring/decisions/stream',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F4.A2 — held-open push tail (follow=1)
// ---------------------------------------------------------------------------

/**
 * Open a real HTTP connection to the follow stream and collect chunks until `predicate` returns true
 * or `timeoutMs` elapses. Resolves with `{ buf, abort }` so the caller can destroy the socket.
 */
function readUntil(
  port: number,
  path: string,
  headers: Record<string, string>,
  predicate: (buf: string) => boolean,
  timeoutMs = 4000,
): Promise<{ buf: string; abort: () => void }> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = httpRequest({ port, host: '127.0.0.1', path, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        if (predicate(buf)) resolve({ buf, abort: () => req.destroy() });
      });
      res.on('end', () => {
        // If the connection ends before the predicate is met, resolve with what we have
        resolve({ buf, abort: () => req.destroy() });
      });
    });
    req.on('error', (err: Error) => {
      // socket destroyed by abort() — not a real error
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve({ buf, abort: () => req.destroy() });
      } else {
        reject(err);
      }
    });
    req.end();
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`readUntil timeout (${timeoutMs}ms); got: ${buf}`));
    }, timeoutMs);
    // Allow the timer to be GC'd — unref so it doesn't keep the process alive
    timer.unref();
  });
}

/** Wait a given number of milliseconds (short delays only). */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForStatus(
  conn: { status: string },
  statuses: string[],
  timeoutMs = 3000,
): Promise<string> {
  const start = Date.now();
  while (!statuses.includes(conn.status)) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return conn.status;
}

describe('GET /v1/monitoring/decisions/stream?follow=1 (live push tail)', () => {
  it('pushes a decision XADDed after the client connected', async ({ skip }) => {
    if (!stores || !app || !redis) return skip();

    const addr = app.server.address();
    if (!addr || typeof addr === 'string') return skip();
    const port = addr.port;

    // Seed one decision first so backlog isn't empty and we get an immediate first chunk,
    // ensuring the HTTP connection is fully open before we XADD the live event.
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_seed',
      agentId,
      orgId,
      outcome: 'ALLOW',
      railScheme: 'raw-x402',
      railChain: 'base',
      resourceId: 'r_seed',
      amount: '1000000',
      ts: 1,
    });

    // Open the stream; wait until we have the seed frame (confirms server is flushing).
    const streamPromise = readUntil(
      port,
      '/v1/monitoring/decisions/stream?follow=1',
      { authorization: `Bearer ${adminKey}` },
      (b) => b.includes('pay_live'),
      5000,
    );

    // Wait for the connection to be established and the seed frame to be flushed.
    await delay(300);

    // XADD the live decision — the server's XREAD BLOCK loop must pick it up.
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_live',
      agentId,
      orgId,
      outcome: 'ALLOW',
      railScheme: 'raw-x402',
      railChain: 'base',
      resourceId: 'r9',
      amount: '2000000',
      ts: 99,
    });

    const { buf, abort } = await streamPromise;
    abort();

    expect(buf).toContain('pay_live');
    expect(buf).toMatch(/id: .+\ndata: .*pay_live/);
  });

  it('releases its dedicated Redis connection when the client disconnects', async ({ skip }) => {
    if (!stores || !app || !redis) return skip();

    const addr = app.server.address();
    if (!addr || typeof addr === 'string') return skip();
    const port = addr.port;

    // Seed one decision so there is an immediate backlog frame on connect.
    await emitDecisionSafe(stores.redis, {
      paymentId: 'pay_teardown_seed',
      agentId,
      orgId,
      outcome: 'ALLOW',
      railScheme: 'raw-x402',
      railChain: 'base',
      resourceId: 'r_td',
      amount: '500000',
      ts: 2,
    });

    const dup = vi.spyOn(stores.redis, 'duplicate');

    // Open the follow stream; resolve as soon as we receive ANY data (backlog frame guarantees this).
    const { abort } = await readUntil(
      port,
      '/v1/monitoring/decisions/stream?follow=1',
      { authorization: `Bearer ${adminKey}` },
      // Resolve on first chunk — backlog frame arrives immediately.
      (b) => b.length > 0,
      5000,
    );

    expect(dup).toHaveBeenCalled();
    // Capture the duplicated sub connection before tearing down.
    const sub = dup.mock.results[0]?.value as Redis | undefined;
    expect(sub).toBeDefined();

    // Disconnect the client — the server's 'close' listener should tear down the sub.
    abort();

    // Poll until the duplicated connection reaches a terminal state (or timeout).
    const status = await waitForStatus(sub as Redis, ['end', 'close']);
    expect(['end', 'close']).toContain(status);

    dup.mockRestore();
  });
});
