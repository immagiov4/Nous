import request from 'supertest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, isPrivateNetworkFrontendOrigin } from '../src/index.js';

describe('private-network frontend origins', () => {
  test('allows the local Vite app from a private LAN address', () => {
    expect(isPrivateNetworkFrontendOrigin('http://192.168.1.126:5173')).toBe(true);
    expect(isPrivateNetworkFrontendOrigin('http://10.0.0.4:5173')).toBe(true);
    expect(isPrivateNetworkFrontendOrigin('http://172.20.0.3:5173')).toBe(true);
  });

  test('rejects public hosts, unexpected ports, and invalid origins', () => {
    expect(isPrivateNetworkFrontendOrigin('http://8.8.8.8:5173')).toBe(false);
    expect(isPrivateNetworkFrontendOrigin('http://192.168.1.126:3000')).toBe(false);
    expect(isPrivateNetworkFrontendOrigin('not-an-origin')).toBe(false);
  });
});

describe('request lifecycle observability', () => {
  afterEach(() => vi.restoreAllMocks());

  test('echoes a safe request correlation ID and records the completed request', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const correlationId = '123e4567-e89b-12d3-a456-426614174000';

    const response = await request(createApp()).get('/health').set('x-request-id', correlationId);

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(correlationId);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`"correlationId":"${correlationId}"`)
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"lifecycle"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"operation":"http_request"'));
  });
});
