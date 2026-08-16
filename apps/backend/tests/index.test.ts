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

  test('assigns correlation before a CORS rejection reaches error handling', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const correlationId = '323e4567-e89b-42d3-a456-426614174002';
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: {
          origin: 'https://rejected.example.test',
          'x-request-id': correlationId,
        },
      });

      expect(response.status).toBe(500);
      expect(response.headers.get('x-request-id')).toBe(correlationId);
      const lifecycleFailure = errorLog.mock.calls
        .flat()
        .find(
          value =>
            typeof value === 'string' &&
            value.includes('"operation":"http_request"') &&
            value.includes('"action":"failed"')
        );
      expect(lifecycleFailure).toContain(`"correlationId":"${correlationId}"`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  test('echoes a safe request correlation ID and records the completed request', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const correlationId = '123e4567-e89b-12d3-a456-426614174000';
    const requestedCorrelationId = correlationId.toUpperCase();
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: { 'x-request-id': requestedCorrelationId },
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

  test('never records user-controlled segments from unmatched request paths', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const privatePathSegment = 'student@example.test';
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/missing/${privatePathSegment}`
      );

      expect(response.status).toBe(404);
      const lifecycleFailure = errorLog.mock.calls
        .flat()
        .find(
          value =>
            typeof value === 'string' &&
            value.includes('"operation":"http_request"') &&
            value.includes('"action":"failed"')
        );
      expect(lifecycleFailure).toContain('"path":"unmatched"');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privatePathSegment);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  test('records mounted route templates without concrete path parameters', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const privatePathSegment = 'student-private-voice';
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/voices/${privatePathSegment}`
      );

      expect(response.status).toBe(404);
      const lifecycleFailure = errorLog.mock.calls
        .flat()
        .find(
          value =>
            typeof value === 'string' &&
            value.includes('"operation":"http_request"') &&
            value.includes('"action":"failed"')
        );
      expect(lifecycleFailure).toContain('"path":"/api/voices/:id"');
      expect(lifecycleFailure).not.toContain(privatePathSegment);
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
      const lifecycleFailures = errorLog.mock.calls
        .flat()
        .filter(
          value =>
            typeof value === 'string' &&
            value.includes('"operation":"http_request"') &&
            value.includes('"action":"failed"')
        );
      expect(lifecycleFailures).toHaveLength(1);
      expect(lifecycleFailures[0]).toContain('"failureCode":"backend_unhandled_error"');
      expect(lifecycleFailures[0]).toContain(`"message":"${internalMessage}"`);
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
