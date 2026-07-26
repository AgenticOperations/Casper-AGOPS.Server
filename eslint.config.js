// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Package build output — generated, and absent in a fresh CI checkout.
      'packages/*/dist/**',
      // Known-stale manual script: imports a facilitator export that no longer exists (see the
      // file header). Excluded so a broken run-by-hand script does not block CI; re-enable once
      // it is rewritten against buildHttpCasperFacilitator.
      'scripts/casper-settle-e2e.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Tooling configs, build scripts and package tests live outside the app's src/test
        // tsconfig. tsconfig.lint.json covers exactly those files so they parse with full type
        // information. `allowDefaultProject` is deliberately not used: it caps at 8 files and
        // hard-errors past that, which this repo already exceeds.
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            'vitest.casper.config.ts',
            'scripts/copy-lua.mjs',
            'validation/spike-1-casper-x402-proof.mjs',
          ],
          defaultProject: 'tsconfig.lint.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The hot path is fail-closed; an unhandled rejection there is a denial we never made.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Security invariant: raw signature bytes / secrets must never be coerced into logs.
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },
  {
    /*
     * Files outside the app's src/test tsconfig: root .mts utilities, the TS build script, and the
     * SDK package's own tests and config. Without an explicit project these belong to no program
     * and typescript-eslint fails to parse them, reporting each as an error.
     *
     * `project` is used rather than `projectService`'s allowDefaultProject, which caps at 8 files
     * and hard-errors past that — a limit this repo already exceeds.
     */
    files: [
      'wrap-cspr.mts',
      'scripts/**/*.ts',
      'scripts/copy-wasm.mjs',
      'packages/agentops-sdk/vitest.config.ts',
      'packages/agentops-sdk/test/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Build helpers run on bare Node (ESM), outside the app's typed src; give them Node globals
    // and let them log build progress.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { URL: 'readonly', console: 'readonly', process: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Validation spikes are executable proof scripts against third-party JS packages; keep syntax linting,
    // but do not apply type-aware safety rules to package surfaces without stable TypeScript types.
    files: ['validation/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    /*
     * Test files. These rules target production hazards that do not apply to test doubles:
     *
     * - require-await: in-memory fakes implement async interfaces (Redis, Pool, submitters) whose
     *   real versions await I/O. Dropping `async` to satisfy the rule would break the interface
     *   the fake exists to satisfy; keeping it is correct and deliberate.
     * - no-unsafe-*: asserting on decoded JSON and on deliberately malformed fixtures means
     *   handling `any`. That is the point of the assertion, not an oversight.
     * - unbound-method: `expect(obj.method)` is the standard vitest spy idiom.
     *
     * Scoped to tests only — the same rules stay ON for src/, where they catch real bugs.
     */
    files: ['test/**/*.ts', 'packages/*/test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
