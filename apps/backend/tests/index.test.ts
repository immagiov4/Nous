import { once } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, isPrivateNetworkFrontendOrigin } from '../src/index.js';
import type { LessonGenerationApi } from '../src/workflows/lessonGenerationApi.js';

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
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: { 'x-request-id': correlationId },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBe(correlationId);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining(`"correlationId":"${correlationId}"`)
      );
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"lifecycle"'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"operation":"http_request"'));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  test('keeps safe internal exception details in backend logs and a stable client response', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const internalMessage = 'Database transaction lost.';
    const lessonGenerationApi = {
      get: vi.fn(),
      start: vi.fn().mockRejectedValue(new Error(internalMessage)),
      startSublesson: vi.fn(),
    } satisfies LessonGenerationApi;
    const server = createApp({ lessonGenerationApi }).listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/lesson-workflows/lessons`,
        {
          body: JSON.stringify({
            projectId: 'project-1',
            requestKey: 'request-1',
            sectionId: 'lesson-1',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: 'Errore interno del server.',
        success: false,
      });
      expect(errorLog).toHaveBeenCalledWith(
        '[Backend] Unhandled error:',
        expect.objectContaining({
          correlationId: expect.any(String),
          diagnostic: {
            message: internalMessage,
            type: 'Error',
          },
          stack: expect.any(String),
        })
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  test('never retains malformed request payloads in unhandled-error logs', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
        body: '{"api_key":"private-credential",',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: 'Errore interno del server.',
        success: false,
      });
      const internalLog = errorLog.mock.calls.find(
        ([message]) => message === '[Backend] Unhandled error:'
      );
      expect(internalLog?.[1]).toMatchObject({
        correlationId: expect.any(String),
        diagnostic: {
          type: 'SyntaxError',
        },
        stack: expect.any(String),
      });
      expect(internalLog?.[1]).not.toHaveProperty('diagnostic.message');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-credential');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });
});
