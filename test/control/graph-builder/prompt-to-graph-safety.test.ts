import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * H.4 — safety: promptToGraph performs NO signing/deploy. Static check that the module has
 * no reference to any signer/deploy/vault symbol, so it is structurally impossible for the
 * LLM's output to trigger a deploy or a signature. The endpoint returns config only.
 */
describe('H.4 promptToGraph static safety check', () => {
  it('has zero references to signer/deploy/vault symbols', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const modulePath = path.join(
      here,
      '../../../src/engines/control/graph-builder/prompt-to-graph.ts',
    );
    const source = readFileSync(modulePath, 'utf8');

    // Forbidden tokens: anything that could plausibly sign a transaction, build/submit a
    // deploy, or touch key/vault material. Case-insensitive; word-boundary-ish via regex.
    const forbiddenPatterns = [
      /signer/i,
      /getClientSigner/i,
      /KeyVault/i,
      /grantDelegatedKey/i,
      /buildSwap/i,
      /submitTransaction/i,
      /casper-js-sdk/i,
      /private[_-]?key/i,
      /\bsign\(/i,
      /\bdeploy\(/i,
      /buildGrantDeploy/i,
    ];

    for (const pattern of forbiddenPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('imports only the graph schema/validator — nothing from casper/custody/identity engines', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const modulePath = path.join(
      here,
      '../../../src/engines/control/graph-builder/prompt-to-graph.ts',
    );
    const source = readFileSync(modulePath, 'utf8');

    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import'));
    for (const line of importLines) {
      expect(line).not.toMatch(/identity\/delegation/);
      expect(line).not.toMatch(/custody/);
      expect(line).not.toMatch(/lib\/casper/);
    }
  });
});
