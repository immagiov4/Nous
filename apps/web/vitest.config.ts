import path from 'node:path';
import { defineConfig } from 'vitest/config';

const TEST_TIMEOUT_MS = 10_000;
// Browser and parser subprocesses share the measured worker resource budget.
const TEST_WORKER_COUNT = 2;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@shared': path.resolve(__dirname, '../../packages/shared-types'),
      '@tabler-icon-nodes': path.resolve(
        __dirname,
        '../../node_modules/@tabler/icons/tabler-nodes-outline.json'
      ),
    },
  },
  test: {
    environment: 'node',
    exclude: ['apps/web/dist/**', 'apps/backend/dist/**', '**/node_modules/**'],
    globals: false,
    maxWorkers: TEST_WORKER_COUNT,
    include: [
      'apps/web/tests/**/*.{test,spec}.{ts,tsx}',
      'apps/backend/tests/**/*.{test,spec}.{ts,tsx}',
      'scripts/**/*.{test,spec}.{ts,tsx}',
      'packages/playtest/tests/**/*.{test,spec}.ts',
      'e2e/**/tests/**/*.{test,spec}.ts',
    ],
    setupFiles: ['./apps/web/tests/setup.ts'],
    testTimeout: TEST_TIMEOUT_MS,
    coverage: {
      provider: 'v8',
      reporter: ['lcovonly'],
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
