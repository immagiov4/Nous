import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  PROJECT_SOURCE_BUCKET,
  type ProjectSourceStorageError,
  SupabaseProjectSourceStorage,
  verifyProjectSourceBytes,
} from '../../src/projects/projectSourceStorage.js';

const SERVICE_ROLE_KEY = 'service-role-key';
const SUPABASE_URL = 'https://project.supabase.co';

const createStorage = (fetcher: typeof fetch) =>
  new SupabaseProjectSourceStorage({
    fetcher,
    serviceRoleKey: SERVICE_ROLE_KEY,
    supabaseUrl: `${SUPABASE_URL}///`,
  });

const createFetchMock = (response: Response) =>
  vi.fn(async () => response) as unknown as typeof fetch;

describe('SupabaseProjectSourceStorage', () => {
  test('uploads immutable bytes to the canonical private bucket', async () => {
    const fetcher = createFetchMock(new Response('{}', { status: 200 }));
    const storage = createStorage(fetcher);
    const bytes = new TextEncoder().encode('source');
    const signal = new AbortController().signal;

    await storage.upload('user-1/project 1/hash', bytes, 'application/pdf', signal);

    expect(PROJECT_SOURCE_BUCKET).toBe('project-sources');
    expect(fetcher).toHaveBeenCalledWith(
      `${SUPABASE_URL}/storage/v1/object/project-sources/user-1/project%201/hash`,
      {
        body: bytes,
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/pdf',
          'x-upsert': 'false',
        },
        method: 'POST',
        signal,
      }
    );
  });

  test('aborts an in-flight upload with the workflow signal', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;
    const storage = createStorage(fetcher);
    const abortController = new AbortController();

    const upload = storage.upload(
      'user-1/project-1/hash',
      new Uint8Array([1]),
      'image/png',
      abortController.signal
    );
    abortController.abort();

    await expect(upload).rejects.toMatchObject({
      cause: expect.objectContaining({ name: 'AbortError' }),
      code: 'upload-failed',
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: abortController.signal })
    );
  });

  test('downloads authenticated bytes and verifies their size and SHA-256', async () => {
    const bytes = new TextEncoder().encode('verified source');
    const fetcher = createFetchMock(new Response(bytes, { status: 200 }));
    const storage = createStorage(fetcher);

    const downloaded = await storage.download('user-1/project-1/hash', {
      byteSize: bytes.byteLength,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });

    expect(downloaded).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith(
      `${SUPABASE_URL}/storage/v1/object/project-sources/user-1/project-1/hash`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        method: 'GET',
      }
    );
  });

  test('verifies an expected immutable object media type when supplied', async () => {
    const bytes = new TextEncoder().encode('not an image');
    const fetcher = createFetchMock(
      new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' }, status: 200 })
    );
    const storage = createStorage(fetcher);

    await expect(
      storage.download('user-1/project-1/hash', {
        byteSize: bytes.byteLength,
        hash: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'image/png',
      })
    ).rejects.toMatchObject({ code: 'integrity-mismatch' });
  });

  test('downloads an exact authenticated byte range without falling back to the full object', async () => {
    const bytes = new TextEncoder().encode('verified');
    const fetcher = createFetchMock(
      new Response(bytes, {
        headers: { 'Content-Range': 'bytes 9-16/40' },
        status: 206,
      })
    );
    const storage = createStorage(fetcher);

    const downloaded = await storage.downloadRange('user-1/project-1/hash', 40, 9, 17);

    expect(downloaded).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith(
      `${SUPABASE_URL}/storage/v1/object/project-sources/user-1/project-1/hash`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          Range: 'bytes=9-16',
        },
        method: 'GET',
      }
    );
  });

  test('rejects ignored or malformed range responses instead of accepting a full download', async () => {
    for (const response of [
      new Response('complete object', { status: 200 }),
      new Response('eightbyt', {
        headers: { 'Content-Range': 'bytes 8-15/40' },
        status: 206,
      }),
      new Response('too short', {
        headers: { 'Content-Range': 'bytes 9-16/40' },
        status: 206,
      }),
    ]) {
      const storage = createStorage(createFetchMock(response));

      await expect(storage.downloadRange('user-1/project-1/hash', 40, 9, 17)).rejects.toMatchObject(
        {
          code: 'range-invalid',
          message: 'Supabase project source range response is invalid.',
        }
      );
    }
  });

  test('deletes through the Storage API', async () => {
    const fetcher = createFetchMock(new Response('[]', { status: 200 }));
    const storage = createStorage(fetcher);

    await storage.delete('user-1/project-1/hash');

    expect(fetcher).toHaveBeenCalledWith(`${SUPABASE_URL}/storage/v1/object/project-sources`, {
      body: JSON.stringify({ prefixes: ['user-1/project-1/hash'] }),
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'DELETE',
    });
  });

  test('reports stable typed request failures without exposing response bodies', async () => {
    const fetcher = createFetchMock(new Response('sensitive provider details', { status: 409 }));
    const storage = createStorage(fetcher);

    await expect(
      storage.upload('user-1/project-1/hash', new Uint8Array([1]), 'application/pdf')
    ).rejects.toMatchObject({
      code: 'upload-failed',
      message: 'Supabase project source upload failed.',
      name: 'ProjectSourceStorageError',
      status: 409,
    });
  });
});

describe('verifyProjectSourceBytes', () => {
  test('rejects size and hash mismatches with a stable integrity error', () => {
    const bytes = new TextEncoder().encode('source');

    for (const expected of [
      { byteSize: bytes.byteLength + 1, hash: createHash('sha256').update(bytes).digest('hex') },
      { byteSize: bytes.byteLength, hash: '0'.repeat(64) },
    ]) {
      expect(() => verifyProjectSourceBytes(bytes, expected)).toThrowError(
        expect.objectContaining<ProjectSourceStorageError>({
          code: 'integrity-mismatch',
          message: 'Supabase project source integrity verification failed.',
          name: 'ProjectSourceStorageError',
        })
      );
    }
  });
});
