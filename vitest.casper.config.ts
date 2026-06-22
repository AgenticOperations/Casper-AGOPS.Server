import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'test/casper/**/*.test.ts',
      'test/casper-guard/**/*.test.ts',
      'test/config/casper-guard.test.ts',
      'test/control/default-org-policies.test.ts',
      'test/control/ids.test.ts',
      'test/control/policy-routes.test.ts',
      'test/identity/**/*.test.ts',
      'test/infra/healthz.test.ts',
      'test/infra/identity-migrations.test.ts',
      'test/infra/migrations-apply.test.ts',
      'test/invariant/agent-holds-no-key.test.ts',
      'test/ledger/hold-inclusive-window.test.ts',
      'test/ledger/hold-release-settle.test.ts',
      'test/monitoring/kill-switch-actuates.test.ts',
      'test/security/**/*.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/server.ts'],
    },
  },
});
