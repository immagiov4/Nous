import path from 'node:path';
import { defineConfig } from 'vitest/config';

const TEST_TIMEOUT_MS = 10_000;
// Measured with browser, parser, and registry tests on the 8-core/16-thread gate host.
const LOAD_SENSITIVE_WORKERS = 2;
const TEST_FILES = [
  'apps/web/tests/**/*.{test,spec}.{ts,tsx}',
  'apps/backend/tests/**/*.{test,spec}.{ts,tsx}',
  'scripts/**/*.{test,spec}.{ts,tsx}',
  'packages/playtest/tests/**/*.{test,spec}.ts',
  'e2e/**/tests/**/*.{test,spec}.ts',
];
// These suites own browser/parser subprocesses, process fixtures, or production registry rebuilds.
const LOAD_SENSITIVE_TESTS = [
  'packages/playtest/tests/**/*.{test,spec}.ts',
  'e2e/**/tests/**/*.{test,spec}.ts',
  'apps/backend/tests/services/mermaidValidation.test.ts',
  'apps/backend/tests/services/pdfTextFallbackProcess.test.ts',
  'apps/backend/tests/workflows/*Compatibility.test.ts',
  'apps/backend/tests/workflows/workflowRuntimeComposition.test.ts',
  'apps/backend/tests/workflows/workflowProcessCrash.integration.test.ts',
  'apps/backend/tests/workflows/postgresWorkflowRunStore.integration.test.ts',
  'apps/backend/tests/workflows/lessonPlaybackStart.integration.test.ts',
  'apps/backend/tests/routes/lessonPlayback.test.ts',
  'scripts/run-eslint-sonar.test.ts',
  'scripts/select-workflow-postgres-contract.test.ts',
  'scripts/summarize-gate-load.test.ts',
];

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
    projects: [
      {
        extends: true,
        test: {
          name: 'load-sensitive',
          include: LOAD_SENSITIVE_TESTS,
          maxWorkers: LOAD_SENSITIVE_WORKERS,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'general',
          include: TEST_FILES,
          exclude: LOAD_SENSITIVE_TESTS,
          sequence: { groupOrder: 2 },
        },
      },
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
