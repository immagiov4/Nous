import { expect, test, vi } from 'vitest';
import { frontendHealth } from './serve-production-frontend.ts';

const backendUrl = 'http://backend:3301/health';
const commit = '14628870fe2cf3e008e7df9fe73da8b99b6dc1f0';

test('public health reports the backend release and prevents caching', async () => {
  const backend = vi.fn(async () => Response.json({ status: 'ok', timestamp: 'ignored', commit }));

  const response = await frontendHealth('GET', backendUrl, backend);

  expect(backend).toHaveBeenCalledWith(
    backendUrl,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok', commit });
});

test('frontend readiness does not contact the backend', async () => {
  const backend = vi.fn();

  const response = await frontendHealth('HEAD', backendUrl, backend);

  expect(response.status).toBe(200);
  expect(await response.text()).toBe('');
  expect(backend).not.toHaveBeenCalled();
});

test('public health omits the release when the backend cannot supply it', async () => {
  const backend = vi.fn(async () => {
    throw new Error('offline');
  });

  const response = await frontendHealth('GET', backendUrl, backend);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});
