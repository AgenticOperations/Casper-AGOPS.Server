import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getReputation } from '../../src/engines/identity/reputation.js';
import {
  startStores,
  stopStores,
  buildOracleApp,
  seedAgent,
  raw402,
  requestContext,
  type Stores,
} from '../helpers/oracle-harness.js';

/**
 * INVARIANT (engine-specs-FINAL.md:237-243): reputation is READ-SIDE and is decoupled from the
 * payment hot path. ServiceScope is a STATIC allowlist precompiled into effective_policy; P3-A reads
 * it from the captured snapshot with NO hot-path call into Engine 7. So a reputation outage — or an
 * agent that is simply UNRATED — can NEVER block or alter a policy-valid payment.
 *
 * This is a guard test: the hot path takes no reputation input, so it passes today. It breaks the
 * moment anyone wires reputation into the decision such that an UNRATED agent is denied — the exact
 * forbidden coupling the spec prohibits (any future live-reputation gate must carry an explicit
 * `strict_reputation` flag and is not in the locked set). Requires Docker; skips when none is available.
 */

const NOW = Math.floor(Date.parse('2026-06-20T00:00:00Z') / 1000);

let stores: Stores | null = null;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  stores = await startStores();
  if (stores) app = buildOracleApp(stores.pool, stores.redis);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await stopStores(stores);
});

describe('reputation is decoupled from the payment hot path (engine-specs-FINAL.md:237-243)', () => {
  it('ALLOWs a brand-new UNRATED agent its policy-valid payment — reputation never gates a payment', async ({
    skip,
  }) => {
    if (!stores || !app) return skip();
    const { agentId, apiKey } = await seedAgent(stores.pool, stores.redis, 10);

    // The agent has zero settled jobs → genuinely UNRATED (reputation gives it the lowest standing).
    const rep = await getReputation({ pool: stores.pool }, { agentId, now: NOW });
    expect(rep).toEqual({ rated: false, status: 'UNRATED' });

    // Its $5 spend is within the $10 SpendCap → must ALLOW. If reputation were ever on the hot path,
    // an UNRATED agent would be blocked here and this assertion would fail.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment/authorize',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { agent_id: agentId, raw_402_body: raw402(5), request_context: requestContext },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ payment_id: string }>().payment_id).toMatch(/^pay_/);
  });

  it('STRUCTURAL: no hot-path engine imports the reputation module (no call into Engine 7)', () => {
    // The behavioural test above is necessary but not sufficient — a coupling that denied a *different*
    // case would slip past it. This is the structural form of the invariant: the authorize spine
    // (Resolution/Enforcement/Oracle) must contain NO reference to the reputation module. It is `identity`
    // -aware (the domain-binding verifier lives there and IS on the hot path), so we forbid `reputation`
    // specifically. Wiring reputation into any of these engines makes the import string appear and fails.
    // Resolve relative to THIS file (cwd-independent), so a drifted process.cwd() cannot point the
    // scan at non-existent dirs and let it pass vacuously.
    const enginesRoot = fileURLToPath(new URL('../../src/engines/', import.meta.url));
    const hotPathDirs = ['enforcement', 'oracle', 'resolution'].map((d) => join(enginesRoot, d));
    const offenders: string[] = [];
    let filesScanned = 0;
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (entry.name.endsWith('.ts')) {
          filesScanned += 1;
          if (/reputation/i.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    // Anti-vacuous guard: every hot-path dir must exist and we must actually read files.
    for (const dir of hotPathDirs) expect(existsSync(dir), `missing hot-path dir ${dir}`).toBe(true);
    hotPathDirs.forEach(scan);
    expect(filesScanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
