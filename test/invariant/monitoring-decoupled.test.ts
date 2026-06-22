import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * INVARIANT (engine-specs-FINAL.md:249,264,327): Monitoring is read-side, NEVER on the hot path, and
 * depended on by NOTHING — its failure must never block spend. So the money-decision core (P2 Resolution
 * quote-assembly + P3 Enforcement decide/sign) must contain NO dependency edge to the monitoring module.
 *
 * The ORACLE (E9) legitimately imports monitoring to emit the fail-open C-10 copy (the spec's "all planes
 * → Monitoring" edge, :60); `emitDecisionSafe` never rejects, so that emit cannot block spend. The oracle
 * is therefore NOT scanned. We assert the ABSENCE of an IMPORT edge (not a comment mention), so a comment
 * that merely says "monitoring" cannot trip it. cwd-independent via import.meta.url + anti-vacuous guards.
 */
describe('Monitoring is decoupled from the money-decision core (engine-specs-FINAL.md:249,264,327)', () => {
  it('no enforcement/resolution module imports the monitoring engine', () => {
    const enginesRoot = fileURLToPath(new URL('../../src/engines/', import.meta.url));
    const coreDirs = ['enforcement', 'resolution'].map((d) => join(enginesRoot, d));
    const offenders: string[] = [];
    let filesScanned = 0;
    const importEdge = /from\s+['"][^'"]*monitoring/;
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (entry.name.endsWith('.ts')) {
          filesScanned += 1;
          if (importEdge.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    // Anti-vacuous guard: every core dir must exist and we must actually read files.
    for (const dir of coreDirs) expect(existsSync(dir), `missing core dir ${dir}`).toBe(true);
    coreDirs.forEach(scan);
    expect(filesScanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
