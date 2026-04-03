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
    exclude: ['dist/**', 'backend/dist/**', '**/node_modules/**'],
    globals: false,
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'backend/tests/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: [
        '**/*.d.ts',
        'dist/**',
        'backend/dist/**',
        '**/node_modules/**',
        'tests/**',
        'tts-server/**',
      ],
    },
  },
});
