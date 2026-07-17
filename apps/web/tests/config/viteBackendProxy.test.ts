import { describe, expect, test } from 'vitest';

import { buildViteApiProxy } from '../../vite.config.ts';

describe('Vite backend proxy', () => {
  test.each([
    '0.0.0.0',
    '::',
  ])('forwards /api unchanged and normalizes the wildcard host %s', wildcardHost => {
    const proxy = buildViteApiProxy({
      VITE_BACKEND_HOST: wildcardHost,
      VITE_BACKEND_PORT: '3302',
    });

    expect(proxy).toEqual({
      '/api': {
        changeOrigin: true,
        target: 'http://127.0.0.1:3302',
      },
    });
    expect(proxy['/api']).not.toHaveProperty('rewrite');
  });
});
