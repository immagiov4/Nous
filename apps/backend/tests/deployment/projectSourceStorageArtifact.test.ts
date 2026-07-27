import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createProjectSourceStorageBackup,
  restoreProjectSourceStorageBackup,
  verifyProjectSourceStorageBackup,
} from '../../../../scripts/project-source-storage-artifact.js';

const encoder = new TextEncoder();
const SERVICE_ROLE_KEY = 'service-role-key';
const SUPABASE_URL = 'https://project.supabase.co';
const DATABASE_DUMP_SHA256 = 'd'.repeat(64);
const temporaryDirectories: string[] = [];

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const createTemporaryPath = async (name: string): Promise<string> => {
  const parent = await mkdtemp(path.join(tmpdir(), 'nous-storage-artifact-'));
  temporaryDirectories.push(parent);
  return path.join(parent, name);
};

const reference = (objectPath: string, content: string) => {
  const bytes = encoder.encode(content);
  return {
    byteSize: bytes.byteLength,
    bytes,
    hash: sha256(bytes),
    objectPath,
  };
};

const storageUrl = (objectPath: string): string =>
  `${SUPABASE_URL}/storage/v1/object/project-sources/${objectPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true }))
  );
});

describe('project source Storage backup artifact', () => {
  test('downloads the exact normalized database reference set and verifies every file', async () => {
    const second = reference('users/user-1/projects/project-1/source/entries/b.txt', 'second');
    const first = reference('users/user-1/projects/project-1/source/original', 'first');
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const bytes = String(url) === storageUrl(first.objectPath) ? first.bytes : second.bytes;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    const directory = await createTemporaryPath('backup');

    await createProjectSourceStorageBackup({
      databaseDumpSha256: DATABASE_DUMP_SHA256,
      directory,
      fetcher,
      references: [
        {
          byte_size: second.byteSize,
          object_path: second.objectPath,
          source_hash: second.hash,
        },
        {
          byte_size: first.byteSize.toString(),
          object_path: first.objectPath,
          source_hash: first.hash,
        },
        {
          byte_size: first.byteSize,
          object_path: first.objectPath,
          source_hash: first.hash,
        },
      ],
      serviceRoleKey: SERVICE_ROLE_KEY,
      supabaseUrl: SUPABASE_URL,
    });

    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    expect(manifest).toEqual({
      bucket: 'project-sources',
      databaseDumpSha256: DATABASE_DUMP_SHA256,
      format: 'nous-project-sources-v1',
      objects: [
        {
          byteSize: second.byteSize,
          hash: second.hash,
          objectPath: second.objectPath,
        },
        {
          byteSize: first.byteSize,
          hash: first.hash,
          objectPath: first.objectPath,
        },
      ],
    });
    expect(await readdir(directory)).toEqual(['manifest.json', 'objects']);
    expect(
      await verifyProjectSourceStorageBackup({
        databaseDumpSha256: DATABASE_DUMP_SHA256,
        directory,
      })
    ).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      storageUrl(first.objectPath),
      expect.objectContaining({
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        method: 'GET',
      })
    );
  });

  test('removes an incomplete artifact when downloaded bytes fail integrity verification', async () => {
    const source = reference('users/user-1/projects/project-1/source/original', 'expected');
    const fetcher = vi.fn(
      async () => new Response('wrong', { status: 200 })
    ) as unknown as typeof fetch;
    const directory = await createTemporaryPath('backup');

    await expect(
      createProjectSourceStorageBackup({
        databaseDumpSha256: DATABASE_DUMP_SHA256,
        directory,
        fetcher,
        references: [
          {
            byte_size: source.byteSize,
            object_path: source.objectPath,
            source_hash: source.hash,
          },
        ],
        serviceRoleKey: SERVICE_ROLE_KEY,
        supabaseUrl: SUPABASE_URL,
      })
    ).rejects.toThrow('integrity');
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a wrong dump pairing, missing object, tampered object, and extra payload', async () => {
    const source = reference('users/user-1/projects/project-1/source/original', 'verified');
    const fetcher = vi.fn(
      async () => new Response(source.bytes, { status: 200 })
    ) as unknown as typeof fetch;
    const directory = await createTemporaryPath('backup');
    await createProjectSourceStorageBackup({
      databaseDumpSha256: DATABASE_DUMP_SHA256,
      directory,
      fetcher,
      references: [
        {
          byte_size: source.byteSize,
          object_path: source.objectPath,
          source_hash: source.hash,
        },
      ],
      serviceRoleKey: SERVICE_ROLE_KEY,
      supabaseUrl: SUPABASE_URL,
    });

    await expect(
      verifyProjectSourceStorageBackup({
        databaseDumpSha256: 'a'.repeat(64),
        directory,
      })
    ).rejects.toThrow('database dump');

    const objectsDirectory = path.join(directory, 'objects');
    const [payloadName] = await readdir(objectsDirectory);
    if (!payloadName) throw new Error('Expected a backed-up object.');
    const payloadPath = path.join(objectsDirectory, payloadName);
    await writeFile(payloadPath, 'tampered');
    await expect(
      verifyProjectSourceStorageBackup({ databaseDumpSha256: DATABASE_DUMP_SHA256, directory })
    ).rejects.toThrow('integrity');

    await rm(payloadPath);
    await expect(
      verifyProjectSourceStorageBackup({ databaseDumpSha256: DATABASE_DUMP_SHA256, directory })
    ).rejects.toThrow('structure');

    await writeFile(payloadPath, source.bytes);
    await writeFile(path.join(objectsDirectory, 'unexpected'), 'extra');
    await expect(
      verifyProjectSourceStorageBackup({ databaseDumpSha256: DATABASE_DUMP_SHA256, directory })
    ).rejects.toThrow('structure');
  });

  test('restores missing objects without upsert and accepts existing objects only after verification', async () => {
    const existing = reference('users/user-1/projects/project-1/source/original', 'existing');
    const missing = reference('users/user-1/projects/project-1/source/entries/a.txt', 'missing');
    const directory = await createTemporaryPath('backup');
    const backupFetcher = vi.fn(async (url: string | URL | Request) => {
      const bytes =
        String(url) === storageUrl(existing.objectPath) ? existing.bytes : missing.bytes;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    const rows = [existing, missing].map(item => ({
      byte_size: item.byteSize,
      object_path: item.objectPath,
      source_hash: item.hash,
    }));
    await createProjectSourceStorageBackup({
      databaseDumpSha256: DATABASE_DUMP_SHA256,
      directory,
      fetcher: backupFetcher,
      references: rows,
      serviceRoleKey: SERVICE_ROLE_KEY,
      supabaseUrl: SUPABASE_URL,
    });

    let missingUploaded = false;
    const restoreFetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === storageUrl(existing.objectPath)) {
        return new Response(existing.bytes, { status: 200 });
      }
      if (init?.method === 'POST') {
        expect(init.headers).toMatchObject({ 'x-upsert': 'false' });
        expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(missing.bytes);
        missingUploaded = true;
        return new Response('{}', { status: 200 });
      }
      return missingUploaded
        ? new Response(missing.bytes, { status: 200 })
        : new Response('missing', { status: 404 });
    });

    await restoreProjectSourceStorageBackup({
      databaseDumpSha256: DATABASE_DUMP_SHA256,
      directory,
      fetcher: restoreFetcher as unknown as typeof fetch,
      references: rows,
      serviceRoleKey: SERVICE_ROLE_KEY,
      supabaseUrl: SUPABASE_URL,
    });

    expect(restoreFetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(restoreFetcher).toHaveBeenCalledTimes(4);
  });

  test('fails before mutation when restored database references differ or existing bytes mismatch', async () => {
    const source = reference('users/user-1/projects/project-1/source/original', 'source');
    const directory = await createTemporaryPath('backup');
    const backupFetcher = vi.fn(
      async () => new Response(source.bytes, { status: 200 })
    ) as unknown as typeof fetch;
    const rows = [
      {
        byte_size: source.byteSize,
        object_path: source.objectPath,
        source_hash: source.hash,
      },
    ];
    await createProjectSourceStorageBackup({
      databaseDumpSha256: DATABASE_DUMP_SHA256,
      directory,
      fetcher: backupFetcher,
      references: rows,
      serviceRoleKey: SERVICE_ROLE_KEY,
      supabaseUrl: SUPABASE_URL,
    });

    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response('different', { status: 200 });
    });
    await expect(
      restoreProjectSourceStorageBackup({
        databaseDumpSha256: DATABASE_DUMP_SHA256,
        directory,
        fetcher: fetcher as unknown as typeof globalThis.fetch,
        references: [],
        serviceRoleKey: SERVICE_ROLE_KEY,
        supabaseUrl: SUPABASE_URL,
      })
    ).rejects.toThrow('database reference');
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      restoreProjectSourceStorageBackup({
        databaseDumpSha256: DATABASE_DUMP_SHA256,
        directory,
        fetcher: fetcher as unknown as typeof globalThis.fetch,
        references: rows,
        serviceRoleKey: SERVICE_ROLE_KEY,
        supabaseUrl: SUPABASE_URL,
      })
    ).rejects.toThrow('integrity');
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
});
