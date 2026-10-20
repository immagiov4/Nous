import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

test('loads configured host and port from the relocated server manifest', async () => {
  vi.resetModules();
  const configured = { backendHost: '192.0.2.42', backendPort: 43210 };
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(configured));
  const { loadServerConfig } = await import('../../src/config/serverConfig.js');
  expect(loadServerConfig()).toEqual(configured);
  expect(readFileSync).toHaveBeenCalledWith(path.resolve('config/server.config.json'), 'utf-8');
});

test('uses defaults when the server manifest is absent', async () => {
  vi.resetModules();
  vi.mocked(existsSync).mockReturnValue(false);
  const { loadServerConfig } = await import('../../src/config/serverConfig.js');
  const { defaultServerConfig } = await import('../../src/config/defaultServerConfig.js');
  expect(loadServerConfig()).toEqual(defaultServerConfig);
  expect(readFileSync).not.toHaveBeenCalled();
});
