import request from 'supertest';
import { afterEach, expect, test, vi } from 'vitest';
import { createApp } from '../../src/index.js';

afterEach(() => vi.unstubAllEnvs());

test('reports the build commit through the unauthenticated readiness route', async () => {
  const commit = '14628870fe2cf3e008e7df9fe73da8b99b6dc1f0';
  vi.stubEnv('NOUS_RELEASE_COMMIT', commit);

  const response = await request(createApp()).get('/health');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok', timestamp: expect.any(String), commit });
});
