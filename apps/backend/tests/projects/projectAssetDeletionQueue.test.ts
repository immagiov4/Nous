import { describe, expect, test, vi } from 'vitest';
import type { ProjectAssetObjectStorage } from '../../src/projects/projectAsset.js';
import { PostgresProjectAssetDeletionQueue } from '../../src/projects/projectAssetDeletionQueue.js';
import { ProjectSourceStorageError } from '../../src/projects/projectSourceStorage.js';

const CLAIM = {
  fencingToken: 3,
  objectPath: 'users/user/projects/project/assets/object',
  workerId: 'asset-worker',
};

const createSql = ({ failUnlock = false }: { failUnlock?: boolean } = {}) => {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const release = vi.fn();
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const statement = strings.join('?');
      statements.push(statement);
      values.push(parameters);
      if (statement.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ acquired: true }]);
      }
      if (
        statement.includes('returning deletion.object_path') ||
        statement.includes('select object_path, cleanup_worker_id')
      ) {
        return Promise.resolve([
          {
            cleanup_fencing_token: CLAIM.fencingToken,
            cleanup_worker_id: CLAIM.workerId,
            object_path: CLAIM.objectPath,
          },
        ]);
      }
      return Promise.resolve(statement.includes('returning object_path') ? [CLAIM] : []);
    }),
    {
      json: vi.fn((value: unknown) => value),
      release,
      reserve: vi.fn(async () => sql),
      unsafe: vi.fn(async (statement: string) => {
        if (failUnlock && statement.includes('pg_advisory_unlock_all')) {
          throw new Error('unlock failed');
        }
      }),
    }
  );
  return { release, sql, statements, values };
};

const storage = (deleteObject = vi.fn(async () => undefined)): ProjectAssetObjectStorage => ({
  delete: deleteObject,
  download: vi.fn(async () => new Uint8Array()),
  upload: vi.fn(async () => undefined),
});

describe('project asset deletion queue', () => {
  test('records object tombstones before deleting project asset rows', async () => {
    const { sql, statements } = createSql();
    vi.mocked(sql).mockImplementation(
      (strings: TemplateStringsArray, ..._parameters: unknown[]) => {
        const statement = strings.join('?');
        statements.push(statement);
        if (statement.includes('select object_path')) {
          return Promise.resolve([{ object_path: 'object/b' }, { object_path: 'object/a' }]);
        }
        return Promise.resolve([]);
      }
    );
    const queue = new PostgresProjectAssetDeletionQueue(sql as never, storage());

    await expect(
      queue.queueProjectAssets(sql as never, { projectId: 'project-1', userId: 'user-1' })
    ).resolves.toEqual(['object/b', 'object/a']);

    expect(statements[0]).toContain('for update');
    expect(statements[1]).toContain('insert into public.project_asset_deletions');
    expect(statements[2]).toContain('delete from public.project_assets');
  });

  test('keeps a sanitized tombstone on Storage failure', async () => {
    const { sql, statements, values } = createSql();
    const deleteObject = vi.fn(async () => {
      throw new ProjectSourceStorageError('delete-failed', 503);
    });
    const queue = new PostgresProjectAssetDeletionQueue(sql as never, storage(deleteObject));

    await expect(queue.cleanupQueuedObject(CLAIM)).resolves.toBe('retrying');

    expect(
      statements.some(statement => statement.includes('update public.project_asset_deletions'))
    ).toBe(true);
    expect(sql.json).toHaveBeenCalledWith({ code: 'delete-failed', status: 503 });
    expect(JSON.stringify(values)).not.toContain('object storage secret');
  });

  test('treats an already absent object as deleted and removes its tombstone', async () => {
    const { sql, statements } = createSql();
    const deleteObject = vi.fn(async () => {
      throw new ProjectSourceStorageError('delete-failed', 404);
    });
    const queue = new PostgresProjectAssetDeletionQueue(sql as never, storage(deleteObject));

    await expect(queue.cleanupQueuedObject(CLAIM)).resolves.toBe('deleted');

    expect(
      statements.some(statement => statement.includes('delete from public.project_asset_deletions'))
    ).toBe(true);
  });

  test('never deletes an object already published by a concurrent archive import', async () => {
    const { sql, statements } = createSql();
    vi.mocked(sql).mockImplementation((strings: TemplateStringsArray) => {
      const statement = strings.join('?');
      statements.push(statement);
      if (statement.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: true }]);
      if (statement.includes('select object_path, cleanup_worker_id')) {
        return Promise.resolve([
          {
            cleanup_fencing_token: CLAIM.fencingToken,
            cleanup_worker_id: CLAIM.workerId,
            object_path: CLAIM.objectPath,
          },
        ]);
      }
      if (statement.includes("state = 'active'")) return Promise.resolve([{ found: 1 }]);
      return Promise.resolve(statement.includes('returning object_path') ? [CLAIM] : []);
    });
    const deleteObject = vi.fn(async () => undefined);
    const queue = new PostgresProjectAssetDeletionQueue(sql as never, storage(deleteObject));

    await expect(queue.cleanupQueuedObject(CLAIM)).resolves.toBe('deleted');

    expect(deleteObject).not.toHaveBeenCalled();
    const activeAssetCheckIndex = statements.findIndex(statement =>
      statement.includes("state = 'active'")
    );
    const tombstoneDeletionIndex = statements.findIndex(statement =>
      statement.includes('delete from public.project_asset_deletions')
    );
    expect(activeAssetCheckIndex).toBeGreaterThanOrEqual(0);
    expect(tombstoneDeletionIndex).toBeGreaterThan(activeAssetCheckIndex);
  });

  test('claims queued objects fairly by attempt count before age', async () => {
    const { sql, statements } = createSql();
    const queue = new PostgresProjectAssetDeletionQueue(sql as never, storage());

    await expect(
      queue.claimNextQueuedObject({ leaseMs: 60_000, workerId: CLAIM.workerId })
    ).resolves.toEqual(CLAIM);
    expect(statements[0]).toContain('order by attempt_count, created_at, object_path');
    expect(statements[0]).toContain('for update skip locked');
  });

  test('does not return the reserved connection when clearing advisory locks fails', async () => {
    const { release, sql } = createSql({ failUnlock: true });
    const queue = new PostgresProjectAssetDeletionQueue(sql as never, storage());

    await expect(queue.cleanupQueuedObject(CLAIM)).rejects.toThrow('unlock failed');

    expect(sql.unsafe).toHaveBeenCalledWith('select pg_advisory_unlock_all()');
    expect(release).not.toHaveBeenCalled();
  });
});
