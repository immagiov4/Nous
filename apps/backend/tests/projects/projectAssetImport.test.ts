import { describe, expect, test, vi } from 'vitest';
import type { ProjectAssetObjectStorage } from '../../src/projects/projectAsset.js';
import {
  PostgresProjectAssetImporter,
  publishImportedProjectAssets,
} from '../../src/projects/projectAssetImport.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

const sourceBytes = new Uint8Array([1, 2, 3]);
const sourceRef = {
  byteSize: sourceBytes.byteLength,
  hash: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
  id: 'a'.repeat(64),
  mediaType: 'image/png',
};
const snapshot: ProjectSnapshot = {
  createdAt: '2026-07-29T20:00:00.000Z',
  id: 'source-project',
  lastOpenedAt: '2026-07-29T20:00:00.000Z',
  learningPlan: {
    sections: [{ generatedVisuals: [{ render: { asset: sourceRef, kind: 'image' } }] }],
  },
  updatedAt: '2026-07-29T20:00:00.000Z',
  version: '4.1',
};

describe('archive project asset preparation', () => {
  test('records cleanup intent before upload and keeps workflow ownership absent', async () => {
    const events: string[] = [];
    const reserved = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        events.push(
          statement.includes('pg_advisory_lock')
            ? 'lock'
            : statement.includes('project_asset_deletions')
              ? 'intent'
              : statement.includes('pg_advisory_unlock')
                ? 'unlock'
                : 'query'
        );
        return Promise.resolve([]);
      }),
      {
        json: vi.fn((value: unknown) => value),
        release: vi.fn(),
        unsafe: vi.fn(async (statement: string) => {
          events.push(statement);
        }),
      }
    );
    const sql = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
    });
    const storage: ProjectAssetObjectStorage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(async () => sourceBytes),
      upload: vi.fn(async () => {
        events.push('upload');
      }),
    };
    const importer = new PostgresProjectAssetImporter(sql as never, storage);

    const prepared = await importer.prepare({
      assets: [{ bytes: sourceBytes, ref: sourceRef }],
      projectId: 'target-project',
      snapshot,
      userId: '00000000-0000-4000-8000-000000000001',
    });

    expect(events.indexOf('intent')).toBeLessThan(events.indexOf('upload'));
    expect(prepared.snapshot.id).toBe('target-project');
    expect(prepared.assets[0]).toMatchObject({
      idempotencyKey: `archive:${sourceRef.id}`,
    });
    expect(prepared.assets[0]).not.toHaveProperty('workflowRunId');
    await prepared.release();
    expect(reserved.release).toHaveBeenCalledOnce();
  });

  test('does not return a reserved session to the pool when clearing advisory locks fails', async () => {
    const reserved = Object.assign(
      vi.fn(() => Promise.resolve([])),
      {
        json: vi.fn((value: unknown) => value),
        release: vi.fn(),
        unsafe: vi.fn(async (statement: string) => {
          if (statement.includes('pg_advisory_unlock_all')) throw new Error('unlock failed');
        }),
      }
    );
    const sql = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
    });
    const storage: ProjectAssetObjectStorage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(async () => sourceBytes),
      upload: vi.fn(async () => undefined),
    };
    const importer = new PostgresProjectAssetImporter(sql as never, storage);
    const prepared = await importer.prepare({
      assets: [{ bytes: sourceBytes, ref: sourceRef }],
      projectId: 'target-project',
      snapshot,
      userId: '00000000-0000-4000-8000-000000000001',
    });

    await expect(prepared.release()).rejects.toThrow('unlock failed');

    expect(reserved.unsafe).toHaveBeenCalledWith('select pg_advisory_unlock_all()');
    expect(reserved.release).not.toHaveBeenCalled();
  });
});

describe('archive project asset publication', () => {
  test('publishes archive origin metadata and clears cleanup intents in one transaction', async () => {
    const events: string[] = [];
    const descriptor = {
      byteSize: sourceRef.byteSize,
      hash: sourceRef.hash,
      id: 'b'.repeat(64),
      idempotencyKey: `archive:${sourceRef.id}`,
      mediaType: sourceRef.mediaType,
      objectPath: `users/user/projects/project/assets/archive/${'b'.repeat(64)}/${sourceRef.hash}`,
    };
    const transaction = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        events.push(statement);
        if (statement.includes('select asset.*') && statement.includes('project_assets')) {
          return Promise.resolve([
            {
              byte_size: descriptor.byteSize,
              content_hash: descriptor.hash,
              id: descriptor.id,
              idempotency_key: descriptor.idempotencyKey,
              media_type: descriptor.mediaType,
              node_instance_id: null,
              object_path: descriptor.objectPath,
              origin_kind: 'archive-import',
              project_id: 'target-project',
              state: 'active',
              user_id: 'user-1',
              workflow_run_id: null,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );

    await publishImportedProjectAssets(transaction as never, {
      assets: [descriptor],
      projectId: 'target-project',
      userId: 'user-1',
    });

    expect(events[0]).toContain('origin_kind');
    expect(events.at(-1)).toContain('delete from public.project_asset_deletions');
  });
});
