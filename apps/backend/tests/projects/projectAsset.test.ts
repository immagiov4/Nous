import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  buildProjectAssetDescriptor,
  ensureProjectAssetUploaded,
  PROJECT_ASSET_BUCKET,
} from '../../src/projects/projectAsset.js';
import {
  ProjectSourceStorageError,
  SupabaseProjectSourceStorage,
} from '../../src/projects/projectSourceStorage.js';

const SERVICE_ROLE_KEY = 'service-role-key';
const SUPABASE_URL = 'https://project.supabase.co';

describe('project asset descriptors', () => {
  test('derives an immutable reference and deterministic object path from identity and bytes', () => {
    const bytes = new TextEncoder().encode('generated image');
    const input = {
      bytes,
      idempotencyKey: 'lesson-1:visual-slot-2:image-1',
      mediaType: 'image/png',
      nodeInstanceId: 'root/render-visual',
      projectId: 'project 1',
      runId: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000001',
    };

    const first = buildProjectAssetDescriptor(input);
    const second = buildProjectAssetDescriptor(input);

    expect(first).toEqual(second);
    expect(first.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(first.objectPath).toMatch(
      /^users\/00000000-0000-4000-8000-000000000001\/projects\/[a-f0-9]{64}\/assets\/[a-f0-9]{64}\/[a-f0-9]{64}$/u
    );
    expect(first).toMatchObject({
      byteSize: bytes.byteLength,
      hash: first.hash,
      id: first.id,
      mediaType: 'image/png',
    });
    expect(first).not.toHaveProperty('bytes');
    expect(first).not.toHaveProperty('dataUrl');
    expect(first).not.toHaveProperty('signedUrl');
  });

  test('keeps the same caller key isolated between workflow runs', () => {
    const common = {
      bytes: new TextEncoder().encode('generated image'),
      idempotencyKey: 'visual-image',
      mediaType: 'image/png',
      nodeInstanceId: 'root/render-visual',
      projectId: 'project-1',
      userId: '00000000-0000-4000-8000-000000000001',
    };

    const first = buildProjectAssetDescriptor({
      ...common,
      runId: '00000000-0000-4000-8000-000000000002',
    });
    const second = buildProjectAssetDescriptor({
      ...common,
      runId: '00000000-0000-4000-8000-000000000003',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.objectPath).not.toBe(second.objectPath);
  });

  test('rejects blank identities before touching persistence or Storage', () => {
    expect(() =>
      buildProjectAssetDescriptor({
        bytes: new Uint8Array(),
        idempotencyKey: ' ',
        mediaType: 'image/png',
        nodeInstanceId: 'root/render-visual',
        projectId: 'project-1',
        runId: '00000000-0000-4000-8000-000000000002',
        userId: '00000000-0000-4000-8000-000000000001',
      })
    ).toThrow('Project asset idempotency key is required.');
  });
});

describe('project asset Storage', () => {
  test('uses the existing immutable Storage client with the private asset bucket', async () => {
    const fetcher = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    const storage = new SupabaseProjectSourceStorage({
      bucket: PROJECT_ASSET_BUCKET,
      fetcher,
      serviceRoleKey: SERVICE_ROLE_KEY,
      supabaseUrl: SUPABASE_URL,
    });
    const bytes = new TextEncoder().encode('image');

    await storage.upload('users/user/projects/project/assets/identity/hash', bytes, 'image/png');

    expect(fetcher).toHaveBeenCalledWith(
      `${SUPABASE_URL}/storage/v1/object/project-assets/users/user/projects/project/assets/identity/hash`,
      expect.objectContaining({
        body: bytes,
        headers: expect.objectContaining({
          'Content-Type': 'image/png',
          'x-upsert': 'false',
        }),
        method: 'POST',
      })
    );
  });

  test('accepts a 409 only after the existing object passes integrity verification', async () => {
    const bytes = new TextEncoder().encode('same image');
    const descriptor = buildProjectAssetDescriptor({
      bytes,
      idempotencyKey: 'visual-image',
      mediaType: 'image/png',
      nodeInstanceId: 'root/render-visual',
      projectId: 'project-1',
      runId: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000001',
    });
    const storage = {
      delete: vi.fn(),
      download: vi.fn(async () => bytes),
      upload: vi.fn(async () => {
        throw new ProjectSourceStorageError('upload-failed', 409);
      }),
    };

    await ensureProjectAssetUploaded(storage, descriptor, bytes);

    expect(storage.download).toHaveBeenCalledWith(descriptor.objectPath, {
      byteSize: descriptor.byteSize,
      hash: descriptor.hash,
      mimeType: descriptor.mediaType,
    });
  });

  test('does not reinterpret other upload failures as idempotent success', async () => {
    const bytes = new TextEncoder().encode('image');
    const descriptor = buildProjectAssetDescriptor({
      bytes,
      idempotencyKey: 'visual-image',
      mediaType: 'image/png',
      nodeInstanceId: 'root/render-visual',
      projectId: 'project-1',
      runId: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000001',
    });
    const failure = new ProjectSourceStorageError('upload-failed', 400);
    const storage = {
      delete: vi.fn(),
      download: vi.fn(),
      upload: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(ensureProjectAssetUploaded(storage, descriptor, bytes)).rejects.toBe(failure);
    expect(storage.download).not.toHaveBeenCalled();
  });

  test('propagates an integrity mismatch for a conflicting object', async () => {
    const bytes = new TextEncoder().encode('expected image');
    const descriptor = buildProjectAssetDescriptor({
      bytes,
      idempotencyKey: 'visual-image',
      mediaType: 'image/png',
      nodeInstanceId: 'root/render-visual',
      projectId: 'project-1',
      runId: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000001',
    });
    const mismatch = new ProjectSourceStorageError('integrity-mismatch');
    const storage = {
      delete: vi.fn(),
      download: vi.fn(async () => {
        throw mismatch;
      }),
      upload: vi.fn(async () => {
        throw new ProjectSourceStorageError('upload-failed', 409);
      }),
    };

    await expect(ensureProjectAssetUploaded(storage, descriptor, bytes)).rejects.toBe(mismatch);
  });
});
