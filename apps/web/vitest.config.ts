import path from 'node:path';
import { defineConfig } from 'vitest/config';

const TEST_TIMEOUT_MS = 10_000;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@shared': path.resolve(__dirname, '../../packages/shared-types'),
    },
  },
  test: {
    environment: 'node',
    exclude: ['apps/web/dist/**', 'apps/backend/dist/**', '**/node_modules/**'],
    globals: false,
    include: [
      'apps/web/tests/**/*.{test,spec}.{ts,tsx}',
      'apps/backend/tests/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.{test,spec}.{ts,tsx}',
    ],
    setupFiles: ['./apps/web/tests/setup.ts'],
    testTimeout: TEST_TIMEOUT_MS,
    coverage: {
      provider: 'v8',
      reporter: ['lcov'],
      exclude: [
        '**/*.d.ts',
        'apps/web/dist/**',
        'apps/backend/dist/**',
        '**/node_modules/**',
        '**/tests/**',
        'services/tts-server/**',
      ],
    },
  },
});
