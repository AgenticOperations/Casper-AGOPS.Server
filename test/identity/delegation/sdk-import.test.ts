import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BOOT-shape regression guard for the delegated-key engine.
 *
 * Vitest's resolver interops CJS named exports, so a static `import { PublicKey } from
 * 'casper-js-sdk'` passes every unit test while CRASHING the real server at boot under Node's
 * ESM loader (`does not provide an export named 'PublicKey'`). This test runs Node's REAL ESM
 * loader in a child process to pin the runtime shape the fixed code relies on: `PublicKey` is
 * reachable via `default ?? top-level`, NOT as a top-level ESM named export. If someone
 * reintroduces a static CJS named import that breaks ESM boot, this fails where the unit tests
 * would not.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('casper-js-sdk ESM-boot shape', () => {
  it('exposes PublicKey via default-or-top under the real ESM loader', () => {
    // A top-level ESM named import of PublicKey must FAIL (proves the SDK is CJS-shaped)...
    expect(() =>
      execFileSync(
        'node',
        ['--input-type=module', '-e', "import { PublicKey } from 'casper-js-sdk'; if (typeof PublicKey !== 'function') process.exit(3)"],
        { cwd: repoRoot, stdio: 'pipe' },
      ),
    ).toThrow();

    // ...but the default-or-top interop the fixed code uses must SUCCEED.
    expect(() =>
      execFileSync(
        'node',
        [
          '--input-type=module',
          '-e',
          "import('casper-js-sdk').then(m => { const s = m.default ?? m; process.exit(typeof s.PublicKey === 'function' ? 0 : 2); })",
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
