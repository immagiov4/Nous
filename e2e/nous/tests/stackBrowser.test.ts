import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

const resources = vi.hoisted(() => ({
  browserClose: vi.fn(),
  frontendClose: vi.fn(),
  setStore: vi.fn(),
}));
vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newPage: async () => ({ route: async () => {}, addInitScript: async () => {} }),
      close: resources.browserClose,
    }),
  },
}));
vi.mock('vite', () => ({
  createServer: async () => ({
    listen: async () => {},
    resolvedUrls: { local: ['http://127.0.0.1:12345'] },
    close: resources.frontendClose,
  }),
}));
vi.mock('../../../apps/backend/src/index', () => ({ createApp: () => () => {} }));
vi.mock('../../../apps/backend/src/projects/projectStore', () => ({
  setProjectStoreForTesting: resources.setStore,
}));

import { withMemoryProjectBrowserStack } from '../stack';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([
  'browser',
  'frontend',
  'backend',
] as const)('restores every owned resource when %s close rejects', async failing => {
  const previous = Object.fromEntries(
    ['NODE_ENV', 'AUTH_MODE', 'LOCAL_USER_ID', 'CORS_ALLOWED_ORIGINS'].map(name => [
      name,
      process.env[name],
    ])
  );
  const close = Server.prototype.close;
  const backendClose = vi.spyOn(Server.prototype, 'close');
  const failure = new Error(`${failing} close failed`);
  resources.browserClose.mockResolvedValue(undefined);
  resources.frontendClose.mockResolvedValue(undefined);
  if (failing === 'backend') {
    backendClose.mockImplementationOnce(function (this: Server, callback) {
      return close.call(this, () => callback?.(failure));
    });
  } else {
    resources[failing === 'browser' ? 'browserClose' : 'frontendClose'].mockRejectedValue(failure);
  }
  try {
    await expect(
      withMemoryProjectBrowserStack({ userId: 'cleanup-test', appOptions: {} }, async () => {})
    ).rejects.toBe(failure);
    expect(resources.browserClose).toHaveBeenCalledOnce();
    expect(resources.frontendClose).toHaveBeenCalledOnce();
    expect(backendClose).toHaveBeenCalledOnce();
    expect(resources.setStore).toHaveBeenLastCalledWith(null);
    for (const [name, value] of Object.entries(previous)) expect(process.env[name]).toBe(value);
  } finally {
    // Release the real listener even when testing the broken cleanup implementation.
    for (const server of backendClose.mock.contexts)
      if (server instanceof Server && server.listening)
        await new Promise<void>(resolve => server.close(() => resolve()));
    resources.setStore(null);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

it.each([
  false,
  true,
])('retains simultaneous cleanup failures (scenario failed: %s)', async scenarioFails => {
  const previous = Object.fromEntries(
    ['NODE_ENV', 'AUTH_MODE', 'LOCAL_USER_ID', 'CORS_ALLOWED_ORIGINS'].map(name => [
      name,
      process.env[name],
    ])
  );
  const scenarioError = new Error('Scenario assertion failed');
  const browserError = new Error('Browser close failed');
  const frontendError = new Error('Frontend close failed');
  const backendError = new Error('Backend close failed');
  const storeError = new Error('Store restore failed');
  resources.browserClose.mockRejectedValue(browserError);
  resources.frontendClose.mockRejectedValue(frontendError);
  resources.setStore.mockImplementation(store => {
    if (store === null) throw storeError;
  });
  const close = Server.prototype.close;
  const backendClose = vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (
    this: Server,
    callback
  ) {
    return close.call(this, () => callback?.(backendError));
  });
  try {
    const error = await withMemoryProjectBrowserStack(
      { userId: 'cleanup-test', appOptions: {} },
      async () => {
        if (scenarioFails) throw scenarioError;
        return 'scenario result';
      }
    ).then(
      () => {
        throw new Error('Expected aggregate failure');
      },
      error => error
    );
    expect(error).toBeInstanceOf(AggregateError);
    const failures = [
      ...(scenarioFails ? [scenarioError] : []),
      browserError,
      frontendError,
      backendError,
      storeError,
    ];
    expect(error.errors).toEqual(failures);
    expect(error.cause).toBe(failures[0]);
    expect(resources.browserClose).toHaveBeenCalledOnce();
    expect(resources.frontendClose).toHaveBeenCalledOnce();
    expect(backendClose).toHaveBeenCalledOnce();
    expect(resources.setStore).toHaveBeenLastCalledWith(null);
    for (const [name, value] of Object.entries(previous)) expect(process.env[name]).toBe(value);
  } finally {
    for (const server of backendClose.mock.contexts)
      if (server instanceof Server && server.listening)
        await new Promise<void>(resolve => close.call(server, () => resolve()));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

it.each([
  false,
  true,
])('preserves scenario outcome when cleanup succeeds (failed: %s)', async fails => {
  const failure = new Error('Scenario assertion failed');
  const pending = withMemoryProjectBrowserStack(
    { userId: 'cleanup-test', appOptions: {} },
    async () => {
      if (fails) throw failure;
      return 'scenario result';
    }
  );
  if (fails) await expect(pending).rejects.toBe(failure);
  else await expect(pending).resolves.toBe('scenario result');
  expect(resources.browserClose).toHaveBeenCalledOnce();
  expect(resources.frontendClose).toHaveBeenCalledOnce();
  expect(resources.setStore).toHaveBeenLastCalledWith(null);
});
