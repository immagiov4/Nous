import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    exclude: ['apps/web/dist/**', 'apps/backend/dist/**', '**/node_modules/**'],
    globals: false,
    include: [
      'apps/web/tests/**/*.{test,spec}.{ts,tsx}',
      'apps/backend/tests/**/*.{test,spec}.{ts,tsx}',
    ],
    setupFiles: ['./apps/web/tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: [
        '**/*.d.ts',
        'apps/web/dist/**',
        'apps/backend/dist/**',
        '**/node_modules/**',
        'apps/web/tests/**',
        'services/tts-server/**',
      ],
    },
  },
});
