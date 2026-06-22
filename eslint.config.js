// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Tooling configs live at the root, outside the src/test tsconfig include.
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            'vitest.casper.config.ts',
            'scripts/copy-lua.mjs',
            'validation/spike-1-casper-x402-proof.mjs',
          ],
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
  prettier,
);
