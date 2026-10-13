import { resolveConfig } from 'vite';
import { describe, expect, test } from 'vitest';

import viteConfig, { buildViteApiProxy } from '../../vite.config.ts';

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

test('retains the Vite 6 JavaScript and CSS browser targets', async () => {
  const configuration = viteConfig({ command: 'build', mode: 'production' });
  const resolved = await resolveConfig({ ...configuration, configFile: false }, 'build');
  const browserBaseline = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'];
  expect(resolved.build.target).toEqual(browserBaseline);
  expect(resolved.build.cssTarget).toEqual(browserBaseline);
});
