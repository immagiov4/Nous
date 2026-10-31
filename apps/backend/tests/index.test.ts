import { once } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, isPrivateNetworkFrontendOrigin } from '../src/index.js';
import { PostgresProjectStore } from '../src/projects/postgresProjectStore.js';
import { setProjectStoreForTesting } from '../src/projects/projectStore.js';
import type { LessonGenerationApi } from '../src/workflows/lessonGenerationApi.js';
import { createSupabaseTestToken } from './helpers/auth.js';

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

  test('keeps successful status polls out of the request log', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);
      await response.text();
      expect(response.ok).toBe(true);
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('"operation":"http_request"'));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test.each([
    '/telemetry-stream',
    '/telemetry-empty',
    '/telemetry-head',
    '/telemetry-unmodified',
  ])('counts bytes and duration for %s', async path => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const app = createApp();
    app.get('/telemetry-stream', (_req, res) => {
      res.write('caffè');
      res.end(Buffer.from(' finale'));
    });
    app.get('/telemetry-empty', (_req, res) => res.status(204).end());
    app.head('/telemetry-head', (_req, res) => res.send('body omitted'));
    app.get('/telemetry-unmodified', (_req, res) => res.status(304).end());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: path === '/telemetry-head' ? 'HEAD' : 'GET',
      });
      const body = await response.text();
      const event = info.mock.calls
        .flat()
        .filter(entry => typeof entry === 'string')
        .map(entry => {
          try {
            return JSON.parse(entry);
          } catch {
            return null;
          }
        })
        .find(
          entry =>
            entry?.operation === 'http_request' &&
            entry?.correlationId === response.headers.get('x-request-id')
        );
      expect(event).toBeDefined();
      expect(event.responseBytes).toBe(Buffer.byteLength(body));
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('records bytes already written when the client closes a stream', async () => {
    const info = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createApp();
    app.get('/telemetry-interrupt', (_req, res) => res.write('caffè'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/telemetry-interrupt`, {
        signal: controller.signal,
      });
      if (!response.body) throw new Error('Expected response stream');
      await response.body.getReader().read();
      controller.abort();
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith(expect.stringContaining('"action":"disconnected"'))
      );
      const event = info.mock.calls
        .flat()
        .filter(entry => typeof entry === 'string')
        .map(entry => {
          try {
            return JSON.parse(entry);
          } catch {
            return null;
          }
        })
        .find(entry => entry?.action === 'disconnected');
      expect(event.responseBytes).toBe(Buffer.byteLength('caffè'));
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(event)).not.toContain('caffè');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('exposes project-load phases and measures a synthetic large course', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const snapshot = {
      id: 'private-synthetic-course',
      version: '4.1',
      sourceKind: 'document',
      state: 'READING',
      source: null,
      isLearnMode: false,
      userProfile: null,
      syllabus: [],
      activeSectionId: null,
      learningPlan: {
        title: 'Synthetic course',
        summary: 'synthetic content '.repeat(200_000),
        sections: [],
      },
    };
    const reserved = Object.assign(
      vi.fn(async () => [
        { snapshot, document_index: null, revision: 1, incarnation_id: 'synthetic' },
      ]),
      { release: vi.fn() }
    );
    const sql = Object.assign(vi.fn(), { reserve: vi.fn(async () => reserved) });
    setProjectStoreForTesting(new PostgresProjectStore(undefined, sql as never));
    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/projects/projects/${snapshot.id}`,
        { headers: { authorization: `Bearer ${createSupabaseTestToken()}` } }
      );
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(body).project.id).toBe(snapshot.id);
      for (const phase of ['poolWait', 'query', 'normalization', 'serialization']) {
        expect(response.headers.get('server-timing')).toContain(`${phase};dur=`);
      }
      const event = info.mock.calls
        .flat()
        .filter(entry => typeof entry === 'string')
        .map(entry => {
          try {
            return JSON.parse(entry);
          } catch {
            return null;
          }
        })
        .find(entry => entry?.operation === 'http_request');
      expect(event.responseBytes).toBe(Buffer.byteLength(body));
      expect(event.durationMs).toBeGreaterThanOrEqual(event.timings.serialization);
      expect(JSON.stringify(event)).not.toContain(snapshot.id);
      expect(JSON.stringify(event)).not.toContain('synthetic content');
      process.stdout.write(`Synthetic project load (mock PostgreSQL): ${JSON.stringify(event)}\n`);
      expect(reserved.release).toHaveBeenCalledOnce();
    } finally {
      setProjectStoreForTesting(null);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

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
      const body = await response.text();
      expect(response.headers.get('server-timing')).toMatch(/serialization;dur=\d/);
      const completed = info.mock.calls
        .flatMap(call => call.filter((entry): entry is string => typeof entry === 'string'))
        .map(entry => {
          try {
            return JSON.parse(entry);
          } catch {
            return null;
          }
        })
        .find(entry => entry?.correlationId === correlationId && entry?.action === 'completed');
      expect(completed).toBeDefined();
      expect(completed.responseBytes).toBe(Buffer.byteLength(body));
      expect(completed.durationMs).toBeGreaterThanOrEqual(completed.timings.serialization);

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
      getByRequestKey: vi.fn(),
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
            originalMessage: internalMessage,
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

  test('records sanitized failure metadata for payload-limit rejections', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const privatePayloadMarker = 'private-payload-marker';
    const oversizedFeedback = `${privatePayloadMarker}${'x'.repeat(3 * 1024 * 1024)}`;
    const server = createApp().listen(0, '127.0.0.1');

    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/feedback`, {
        body: JSON.stringify({ description: oversizedFeedback }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(413);
      const lifecycleFailure = errorLog.mock.calls
        .flat()
        .find(
          value =>
            typeof value === 'string' &&
            value.includes('"operation":"http_request"') &&
            value.includes('"action":"failed"')
        );
      expect(lifecycleFailure).toContain('"failureCode":"request_payload_too_large"');
      expect(lifecycleFailure).toContain('"status":413');
      expect(lifecycleFailure).not.toContain(privatePayloadMarker);
      expect(warn).toHaveBeenCalledWith(
        '[Backend] Request payload too large:',
        expect.objectContaining({ correlationId: expect.any(String), status: 413 })
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });
});

test('rejected project authentication includes auth timing before headers and completion logs', async () => {
  vi.stubEnv('AUTH_MODE', 'supabase');
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/projects/course`);
    expect(response.status).toBe(401);
    await response.text();
    expect(response.headers.get('server-timing')).toMatch(/auth;dur=\d/);
    const entries = errorLog.mock.calls
      .flat()
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => JSON.parse(entry));
    expect(
      entries.find(entry => entry.correlationId === response.headers.get('x-request-id'))?.timings
        .auth
    ).toBeTypeOf('number');
  } finally {
    vi.unstubAllEnvs();
    errorLog.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
