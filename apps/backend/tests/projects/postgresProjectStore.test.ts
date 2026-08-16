import { createHash } from 'node:crypto';
import {
  createProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';
import JSZip from 'jszip';
import { describe, expect, test, vi } from 'vitest';

import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import {
  ProjectNotFoundError,
  ProjectRevisionConflictError,
} from '../../src/projects/projectRevision.js';
import { buildProjectSourceObjectPath } from '../../src/projects/projectSource.js';
import { ProjectSourceStorageError } from '../../src/projects/projectSourceStorage.js';
import type { ProjectSnapshot, SavedProjectMeta } from '../../src/projects/types.js';

const PROJECT_META: SavedProjectMeta = {
  id: 'large-pdf-project',
  title: 'Reti',
  sourceKind: 'document',
  createdAt: '2026-07-07T10:00:00.000Z',
  updatedAt: '2026-07-07T10:00:00.000Z',
  lastOpenedAt: '2026-07-07T10:00:00.000Z',
  lessonCount: 23,
  completedCount: 5,
  exerciseCount: 1,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: '23 lezioni',
};

const createMultiSourceSnapshot = (): ProjectSnapshot => ({
  activeSectionId: null,
  id: PROJECT_META.id,
  isLearnMode: false,
  projectFormatVersion: 1,
  version: '4.1',
  sourceKind: 'document',
  state: 'READING',
  source: {
    file: {
      data: 'Zmlyc3Q=',
      mimeType: 'text/plain',
      name: 'notes.txt',
      sourceId: 'source-first',
    },
    kind: 'document',
    sources: [
      {
        file: {
          data: 'Zmlyc3Q=',
          mimeType: 'text/plain',
          name: 'notes.txt',
          sourceId: 'source-first',
        },
        hash: 'hash-source-first',
        id: 'source-first',
        kind: 'text',
        name: 'notes.txt',
        outline: [],
        outlineOrigin: 'none',
        position: 0,
        status: 'ready',
      },
      {
        file: {
          data: 'c2Vjb25k',
          mimeType: 'text/plain',
          name: 'notes.txt',
          sourceId: 'source-second',
        },
        hash: 'hash-source-second',
        id: 'source-second',
        kind: 'text',
        name: 'notes.txt',
        outline: [],
        outlineOrigin: 'none',
        position: 1,
        status: 'ready',
      },
    ],
  },
  learningPlan: { title: 'Reti', sections: [] },
  syllabus: [],
  userProfile: null,
  createdAt: PROJECT_META.createdAt,
  updatedAt: PROJECT_META.updatedAt,
  lastOpenedAt: PROJECT_META.lastOpenedAt,
});

const createPostgresProjectStore = (
  sqlClient: ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    reserve?: ReturnType<typeof vi.fn>;
  },
  storage?: {
    delete: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
    downloadRange?: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
  },
  projectAssetDeletions = {
    claimNextQueuedObject: vi.fn(async () => null),
    cleanupQueuedObject: vi.fn(async () => 'deleted' as const),
    queueProjectAssets: vi.fn(async () => []),
  }
) => {
  let transactionSql: ReturnType<typeof vi.fn> | undefined;
  const reservedSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    (transactionSql ?? sqlClient)(strings, ...values)
  );
  Object.assign(reservedSql, {
    json: sqlClient.json,
    release: vi.fn(),
    unsafe: vi.fn(async (statement: string) => {
      if (statement === 'begin') {
        await sqlClient.begin(async (sql: ReturnType<typeof vi.fn>) => {
          transactionSql = sql;
        });
      } else if (statement === 'commit' || statement === 'rollback') {
        transactionSql = undefined;
      }
      return [];
    }),
  });
  sqlClient.reserve = vi.fn(async () => reservedSql);
  return new PostgresProjectStore(
    undefined,
    sqlClient as never,
    storage ? { downloadRange: vi.fn(), ...storage } : undefined,
    projectAssetDeletions
  );
};

describe('PostgresProjectStore', () => {
  test('reports missing projects consistently for favorite and touch writes', async () => {
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await expect(
      store.setProjectFavorite('user-1', 'missing-project', true)
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(store.touchProject('user-1', 'missing-project')).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
    await expect(
      store.saveProjectCover('user-1', 'missing-project', {
        data: 'ZmFrZQ==',
        mimeType: 'image/png',
        name: 'cover.png',
      })
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  test('does not recreate a project deleted between patch load and transactional lock', async () => {
    const snapshot = { ...createMultiSourceSnapshot(), source: null };
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        transactionStatements.push(strings.join('?'));
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (
          statement.includes('from public.project_snapshots') &&
          statement.includes('join public.projects')
        ) {
          return Promise.resolve([{ document_index: null, revision: 4, snapshot }]);
        }
        if (statement.includes('select meta, revision')) {
          return Promise.resolve([{ meta: PROJECT_META, revision: 4 }]);
        }
        if (statement.includes('select snapshot, document_index')) {
          return Promise.resolve([{ document_index: null, snapshot }]);
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await expect(
      store.patchProject('user-1', snapshot.id, { title: 'Patch tardiva' })
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    expect(transactionStatements).toHaveLength(1);
    expect(transactionStatements[0]).toContain('for update');
    expect(
      transactionStatements.some(statement => statement.includes('insert into public.projects'))
    ).toBe(false);
  });

  test('loads requested project snapshots in one query and preserves request order', async () => {
    const firstSnapshot = createMultiSourceSnapshot();
    const secondSnapshot = {
      ...createMultiSourceSnapshot(),
      id: 'second-project',
      learningPlan: { title: 'Secondo', sections: [] },
    };
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        statements.push(strings.join('?'));
        return Promise.resolve([
          { document_index: null, id: secondSnapshot.id, snapshot: secondSnapshot },
          { document_index: null, id: firstSnapshot.id, snapshot: firstSnapshot },
        ]);
      }),
      {
        begin: vi.fn(),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    const snapshots = await store.loadProjectsById('user-1', [
      firstSnapshot.id,
      secondSnapshot.id,
      'missing-project',
    ]);

    expect(snapshots.map(snapshot => snapshot.id)).toEqual([firstSnapshot.id, secondSnapshot.id]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('id = any');
  });

  test('repairs every missing library placement with a constant-size transaction', async () => {
    const transactionValues: unknown[][] = [];
    let transactionCallIndex = 0;
    const sqlClient = Object.assign(
      vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
        transactionValues.push(values);
        const result = transactionCallIndex === 0 ? [{ id: 'project-1' }] : [];
        transactionCallIndex += 1;
        return Promise.resolve(result);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof sqlClient) => Promise<unknown>) =>
          operation(sqlClient)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await expect(store.listPlacements('user-1')).resolves.toEqual([]);

    expect(sqlClient.begin).toHaveBeenCalledTimes(1);
    expect(transactionValues).toHaveLength(4);
    expect(transactionValues[1]?.[0]).toEqual([
      JSON.stringify(['library-sibling-order', 'user-1', null]),
    ]);
    expect(transactionValues[2]).toContainEqual(['project-1']);
  });

  test('deduplicates moves and persists one complete source-to-destination sibling batch', async () => {
    const placements = [
      {
        folderId: 'folder-a',
        order: 1024,
        projectId: 'project-1',
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
      {
        folderId: 'folder-b',
        order: 2048,
        projectId: 'project-2',
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
    ];
    const folders = [
      {
        createdAt: '2026-07-07T10:00:00.000Z',
        id: 'folder-a',
        name: 'A',
        order: 1024,
        parentFolderId: null,
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
      {
        createdAt: '2026-07-07T10:00:00.000Z',
        id: 'folder-b',
        name: 'B',
        order: 2048,
        parentFolderId: null,
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
      {
        createdAt: '2026-07-07T10:00:00.000Z',
        id: 'project-1',
        name: 'Same ID as moved project',
        order: 1536,
        parentFolderId: 'folder-b',
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
    ];
    const transactionValues: unknown[][] = [];
    let transactionCallIndex = 0;
    const transactionSql = Object.assign(
      vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
        transactionValues.push(values);
        const result =
          transactionCallIndex === 3
            ? [
                {
                  folder_count: 1,
                  missing_folder_count: 0,
                  missing_project_count: 0,
                  parent_exists: true,
                  project_count: 2,
                  unexpected_folder_count: 0,
                  unexpected_project_count: 0,
                },
              ]
            : [];
        transactionCallIndex += 1;
        return Promise.resolve(result);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const rootResults = [
      placements.map(placement => ({ placement })),
      folders.map(folder => ({ folder })),
      [{ folder: folders[1] }],
    ];
    let rootCallIndex = 0;
    const sqlClient = Object.assign(
      vi.fn(() => {
        const result = rootResults[rootCallIndex] ?? [];
        rootCallIndex += 1;
        return Promise.resolve(result);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await expect(
      store.moveProjects('user-1', ['project-1', 'project-1'], 'folder-b', 0)
    ).resolves.toHaveLength(2);

    expect(sqlClient.begin).toHaveBeenCalledTimes(2);
    expect(rootCallIndex).toBe(3);
    expect(transactionValues).toHaveLength(4);
    expect(transactionValues[1]?.[0]).toEqual([
      JSON.stringify(['library-sibling-order', 'user-1', 'folder-a']),
      JSON.stringify(['library-sibling-order', 'user-1', 'folder-b']),
    ]);
    expect(transactionValues[2]).toContainEqual([
      {
        id: 'project-1',
        kind: 'project',
        source_parent_folder_id: 'folder-a',
      },
    ]);
    const siblingPayload = transactionValues[3]?.find(value => Array.isArray(value));
    expect(siblingPayload).toEqual([
      {
        id: 'project-1',
        incoming: true,
        kind: 'project',
        value: {
          folderId: 'folder-b',
          order: 1024,
          projectId: 'project-1',
          updatedAt: expect.any(String),
        },
      },
      {
        id: 'project-1',
        incoming: false,
        kind: 'folder',
        value: {
          createdAt: '2026-07-07T10:00:00.000Z',
          id: 'project-1',
          name: 'Same ID as moved project',
          order: 2048,
          parentFolderId: 'folder-b',
          updatedAt: expect.any(String),
        },
      },
      {
        id: 'project-2',
        incoming: false,
        kind: 'project',
        value: {
          folderId: 'folder-b',
          order: 3072,
          projectId: 'project-2',
          updatedAt: expect.any(String),
        },
      },
    ]);
  });

  test('loads a project snapshot and its revision in one joined query', async () => {
    const storedSnapshot = createMultiSourceSnapshot();
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        statements.push(strings.join('?'));
        return Promise.resolve([{ document_index: null, revision: '7', snapshot: storedSnapshot }]);
      }),
      {
        begin: vi.fn(),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await expect(store.loadProjectWithRevision('user-1', 'project-1')).resolves.toMatchObject({
      revision: 7,
      snapshot: { id: 'large-pdf-project', learningPlan: { title: 'Reti' } },
    });
    expect(statements[0]).toContain('join public.projects');
    expect(statements[0]).toContain('projects.revision');
  });

  test('creates project, detached snapshot, and every source metadata row in one transaction', async () => {
    const transactionStatements: string[] = [];
    const transactionValues: unknown[][] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        transactionValues.push(values);
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    await store.saveProject('user-1', createMultiSourceSnapshot());

    expect(sqlClient.begin).toHaveBeenCalledTimes(1);
    const projectInsertIndex = transactionStatements.findIndex(statement =>
      statement.includes('insert into public.projects')
    );
    const sourceInsertIndex = transactionStatements.findIndex(statement =>
      statement.includes('insert into public.project_sources')
    );
    expect(projectInsertIndex).toBeGreaterThanOrEqual(0);
    expect(sourceInsertIndex).toBeGreaterThan(projectInsertIndex);
    expect(
      transactionStatements.some(statement => statement.includes('project_source_files'))
    ).toBe(true);
    expect(
      transactionStatements.some(statement =>
        statement.includes('delete from public.project_source_deletions')
      )
    ).toBe(true);
    const snapshotStatementIndex = transactionStatements.findIndex(statement =>
      statement.includes('insert into public.project_snapshots')
    );
    expect(snapshotStatementIndex).toBeGreaterThan(sourceInsertIndex);
    const placementStatementIndex = transactionStatements.findIndex(statement =>
      statement.includes('insert into public.library_placements')
    );
    expect(placementStatementIndex).toBeGreaterThan(snapshotStatementIndex);
    expect(JSON.stringify(transactionValues[snapshotStatementIndex])).not.toContain('Zmlyc3Q=');
    expect(JSON.stringify(transactionValues[snapshotStatementIndex])).not.toContain('c2Vjb25k');
  });

  test('deletes every newly uploaded source when the atomic project transaction rolls back', async () => {
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        if (statement.includes('insert into public.project_snapshots')) {
          throw new Error('snapshot write failed');
        }
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        );
      }),
      {
        json: vi.fn((value: unknown) => value),
      }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async (path: string) => {
        if (path.includes('source-first')) {
          throw new ProjectSourceStorageError('delete-failed', 503);
        }
      }),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    await expect(store.saveProject('user-1', createMultiSourceSnapshot())).rejects.toThrow(
      'snapshot write failed'
    );

    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(sqlClient.begin).toHaveBeenCalledTimes(2);
    expect(
      transactionStatements.some(
        statement =>
          statement.includes('insert into public.project_source_deletions') &&
          statement.includes('values')
      )
    ).toBe(true);
  });

  test('does not delete a rolled-back upload that a concurrent transaction adopted', async () => {
    const adoptedPath = buildProjectSourceObjectPath(
      'user-1',
      PROJECT_META.id,
      'source-first',
      createHash('sha256').update('first').digest('hex')
    );
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join('?');
        if (statement.includes('insert into public.project_snapshots')) {
          throw new Error('snapshot write failed');
        }
        if (statement.includes('referenced_source') && values.includes(adoptedPath)) {
          return Promise.resolve([{ found: 1 }]);
        }
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    await expect(store.saveProject('user-1', createMultiSourceSnapshot())).rejects.toThrow(
      'snapshot write failed'
    );

    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalledWith(adoptedPath);
  });

  test('retries queued source deletion during the next library read', async () => {
    const queuedPath = 'users/user-1/projects/project/source/hash/original';
    let deletionAttempts = 0;
    const transactionSql = Object.assign(
      vi.fn(() => Promise.resolve([])),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('from public.project_source_deletions')) {
          return Promise.resolve([{ object_path: queuedPath }]);
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => {
        deletionAttempts += 1;
        if (deletionAttempts === 1) {
          throw new ProjectSourceStorageError('delete-failed', 503);
        }
      }),
      download: vi.fn(),
      upload: vi.fn(),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    await store.listProjects('user-1');
    await vi.waitFor(() => expect(storage.delete).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      await store.listProjects('user-1');
      expect(storage.delete).toHaveBeenCalledTimes(2);
    });

    expect(
      transactionSql.mock.calls.some(([strings]) =>
        (strings as TemplateStringsArray)
          .join('?')
          .includes('delete from public.project_source_deletions')
      )
    ).toBe(true);
  });

  test('returns the library while queued source deletion remains pending', async () => {
    const queuedPath = 'users/user-1/projects/project/source/hash/original';
    let finishDeletion!: () => void;
    const pendingDeletion = new Promise<void>(resolve => {
      finishDeletion = resolve;
    });
    const transactionSql = Object.assign(
      vi.fn(() => Promise.resolve([])),
      {
        json: vi.fn((value: unknown) => value),
      }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('from public.project_source_deletions')) {
          return Promise.resolve([{ object_path: queuedPath }]);
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(() => pendingDeletion),
      download: vi.fn(),
      upload: vi.fn(),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    await expect(store.listProjects('user-1')).resolves.toEqual([]);
    await vi.waitFor(() => expect(storage.delete).toHaveBeenCalledOnce());

    finishDeletion();
    await vi.waitFor(() =>
      expect(
        transactionSql.mock.calls.some(([strings]) =>
          (strings as TemplateStringsArray)
            .join('?')
            .includes('delete from public.project_source_deletions')
        )
      ).toBe(true)
    );
  });

  test.each([
    400, 409,
  ])('verifies an immutable source collision returned as HTTP %s', async status => {
    const sourceBytes = new TextEncoder().encode('first');
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        )
      ),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(async () => sourceBytes),
      upload: vi.fn(async () => {
        throw new ProjectSourceStorageError('upload-failed', status);
      }),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const snapshot = createMultiSourceSnapshot();
    const source = snapshot.source as {
      file: { data: string };
      sources: Array<{ file: { data: string } }>;
    };
    source.sources = [source.sources[0]];

    await store.saveProject('user-1', snapshot);

    expect(storage.download).toHaveBeenCalledWith(expect.any(String), {
      byteSize: sourceBytes.byteLength,
      hash: createHash('sha256').update(sourceBytes).digest('hex'),
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  test('uses a new immutable object path when a descriptor keeps its ID but changes bytes', async () => {
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        )
      ),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const first = createMultiSourceSnapshot();
    const firstSource = first.source as {
      file: { data: string };
      sources: Array<{ file: { data: string } }>;
    };
    firstSource.sources = [firstSource.sources[0]];
    const second = structuredClone(first);
    const secondSource = second.source as {
      file: { data: string };
      sources: Array<{ file: { data: string } }>;
    };
    secondSource.file.data = 'cmVwbGFjZWQ=';
    secondSource.sources[0].file.data = 'cmVwbGFjZWQ=';

    await store.saveProject('user-1', first);
    await store.saveProject('user-1', second);

    const uploadedPaths = storage.upload.mock.calls.map(([path]) => path);
    expect(uploadedPaths).toHaveLength(2);
    expect(new Set(uploadedPaths).size).toBe(2);
    expect(uploadedPaths[0]).toContain(createHash('sha256').update('first').digest('hex'));
    expect(uploadedPaths[1]).toContain(createHash('sha256').update('replaced').digest('hex'));
  });

  test('keeps a reattached archive source ID while moving changed bytes to a new path', async () => {
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        )
      ),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const buildArchiveSnapshot = async (content: string): Promise<ProjectSnapshot> => {
      const archive = new JSZip();
      archive.file('src/main.ts', content);
      const bytes = await archive.generateAsync({ type: 'uint8array' });
      return {
        ...createMultiSourceSnapshot(),
        sourceKind: 'codebase',
        source: {
          file: {
            data: Buffer.from(bytes).toString('base64'),
            mimeType: 'application/zip',
            name: 'engine.zip',
            sourceId: 'source-stable-archive',
          },
          index: { entries: [] },
          kind: 'archive',
          name: 'engine.zip',
        },
      };
    };

    await store.saveProject('user-1', await buildArchiveSnapshot('export const value = 1;'));
    await store.saveProject('user-1', await buildArchiveSnapshot('export const value = 2;'));

    const originalPaths = storage.upload.mock.calls
      .map(([path]) => path as string)
      .filter(path => path.endsWith('/original'));
    expect(originalPaths).toHaveLength(2);
    expect(new Set(originalPaths).size).toBe(2);
    expect(originalPaths.every(path => path.includes('/source-stable-archive/'))).toBe(true);
  });

  test('rejects a detached source when the project has no stored source metadata', async () => {
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(),
      download: vi.fn(),
      upload: vi.fn(),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const snapshot = {
      ...createMultiSourceSnapshot(),
      source: {
        file: { data: '', mimeType: 'text/plain', name: 'source.txt' },
        kind: 'document',
        ref: {
          byteSize: 5,
          hash: 'a'.repeat(64),
          id: 'source-detached',
          mimeType: 'text/plain',
          name: 'source.txt',
          objectPath: `users/user/projects/project/source-detached/${'a'.repeat(64)}/original`,
        },
      },
    } satisfies ProjectSnapshot;

    await expect(store.saveProject('user-1', snapshot)).rejects.toThrow(
      'Detached project source has no stored metadata.'
    );

    expect(sqlClient.begin).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  test('stores source bytes only in immutable object storage and persists metadata', async () => {
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const sourceBytes = new TextEncoder().encode('complete source');
    const source = {
      data: Buffer.from(sourceBytes).toString('base64'),
      mimeType: 'application/pdf',
      name: 'manuale.pdf',
    };

    const hash = createHash('sha256').update(sourceBytes).digest('hex');
    const sourceId = `source-${hash.slice(0, 24)}`;
    await store.saveProject('user-1', {
      ...createMultiSourceSnapshot(),
      id: 'project/with unsafe id',
      source: { file: source, kind: 'pdf' },
    });

    const expectedPath = buildProjectSourceObjectPath(
      'user-1',
      'project/with unsafe id',
      sourceId,
      hash
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expectedPath,
      expect.any(Uint8Array),
      source.mimeType
    );
    expect(new Uint8Array(storage.upload.mock.calls[0]?.[1])).toEqual(sourceBytes);
    expect(transactionStatements.some(statement => statement.includes('object_path'))).toBe(true);
    expect(transactionStatements.every(statement => !/\bdata\b/u.test(statement))).toBe(true);
  });

  test('removes a newly uploaded object when its metadata transaction fails', async () => {
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        if (strings.join('?').includes('insert into public.project_snapshots')) {
          throw new Error('database unavailable');
        }
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const source = {
      data: Buffer.from('source transaction').toString('base64'),
      mimeType: 'text/plain',
      name: 'source.txt',
    };

    await expect(
      store.saveProject('user-1', {
        ...createMultiSourceSnapshot(),
        source: { file: source, kind: 'document' },
      })
    ).rejects.toThrow('database unavailable');

    const hash = createHash('sha256').update('source transaction').digest('hex');
    const refId = `source-${hash.slice(0, 24)}`;
    expect(storage.delete).toHaveBeenCalledWith(
      buildProjectSourceObjectPath('user-1', PROJECT_META.id, refId, hash)
    );
  });

  test('stores duplicate-named course sources as distinct immutable objects and metadata rows', async () => {
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const snapshot = createMultiSourceSnapshot();
    const source = snapshot.source as {
      file: { sourceId: string };
      sources: Array<{ file: { sourceId: string }; id: string }>;
    };
    source.file.sourceId = 'source-duplicate-1';
    source.sources[0].id = 'source-duplicate-1';
    source.sources[0].file.sourceId = 'source-duplicate-1';
    source.sources[1].id = 'source-duplicate-2';
    source.sources[1].file.sourceId = 'source-duplicate-2';
    await store.saveProject('user-1', snapshot);

    expect(storage.upload.mock.calls.map(([path]) => path)).toEqual([
      buildProjectSourceObjectPath(
        'user-1',
        PROJECT_META.id,
        'source-duplicate-1',
        createHash('sha256').update('first').digest('hex')
      ),
      buildProjectSourceObjectPath(
        'user-1',
        PROJECT_META.id,
        'source-duplicate-2',
        createHash('sha256').update('second').digest('hex')
      ),
    ]);
    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(new Set(storage.upload.mock.calls.map(([path]) => path)).size).toBe(2);
    expect(
      transactionStatements.some(statement => statement.includes('project_source_files'))
    ).toBe(true);
    expect(transactionStatements.every(statement => !/\bdata\b/u.test(statement))).toBe(true);
  });

  test('loads and verifies every stored course source in stable position order', async () => {
    const firstBytes = new TextEncoder().encode('first');
    const secondBytes = new TextEncoder().encode('second');
    const rows = [
      {
        byte_size: firstBytes.byteLength,
        mime_type: 'text/plain',
        name: 'notes.txt',
        object_path: 'users/user/projects/project/source-duplicate-1/original',
        position: 0,
        source_hash: createHash('sha256').update(firstBytes).digest('hex'),
        source_id: 'source-duplicate-1',
      },
      {
        byte_size: secondBytes.byteLength,
        mime_type: 'text/plain',
        name: 'notes.txt',
        object_path: 'users/user/projects/project/source-duplicate-2/original',
        position: 1,
        source_hash: createHash('sha256').update(secondBytes).digest('hex'),
        source_id: 'source-duplicate-2',
      },
    ];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) =>
        Promise.resolve(strings.join('?').includes('project_source_files') ? rows : [])
      ),
      { json: vi.fn((value: unknown) => value) }
    );
    const storage = {
      delete: vi.fn(),
      download: vi.fn(async (path: string) =>
        path.includes('duplicate-1') ? firstBytes : secondBytes
      ),
      upload: vi.fn(),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const sources = await store.loadProjectSources('user-1', PROJECT_META.id);

    expect(sources.map(source => source.ref.id)).toEqual([
      'source-duplicate-1',
      'source-duplicate-2',
    ]);
    expect(sources.map(source => source.file.data)).toEqual([
      Buffer.from(firstBytes).toString('base64'),
      Buffer.from(secondBytes).toString('base64'),
    ]);
    expect(storage.download).toHaveBeenCalledTimes(2);
  });

  test('queues and removes replaced primary and secondary source objects', async () => {
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('from public.project_sources') && statement.includes('for update')) {
          return Promise.resolve([{ object_path: 'storage/old-primary' }]);
        }
        if (
          statement.includes('from public.project_source_files') &&
          statement.includes('for update')
        ) {
          return Promise.resolve([
            { object_path: 'storage/old-primary' },
            { object_path: 'storage/old-secondary' },
          ]);
        }
        if (statement.includes('returning meta, revision')) {
          return Promise.resolve([{ meta: PROJECT_META, revision: 2 }]);
        }
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const snapshot = createMultiSourceSnapshot();
    const source = snapshot.source as {
      file: { data: string; mimeType: string; name: string; sourceId: string };
      sources: Array<{
        file: { data: string; mimeType: string; name: string; sourceId: string };
        hash: string;
        id: string;
        kind: string;
        name: string;
        outline: unknown[];
        outlineOrigin: string;
        position: number;
        status: string;
      }>;
    };
    source.file = {
      data: 'bmV3',
      mimeType: 'text/plain',
      name: 'new.txt',
      sourceId: 'source-new',
    };
    source.sources = [
      {
        file: {
          data: 'bmV3',
          mimeType: 'text/plain',
          name: 'new.txt',
          sourceId: 'source-new',
        },
        hash: 'hash-source-new',
        id: 'source-new',
        kind: 'text',
        name: 'new.txt',
        outline: [],
        outlineOrigin: 'none',
        position: 0,
        status: 'ready',
      },
    ];
    await store.saveProject('user-1', snapshot);

    expect(storage.delete).toHaveBeenCalledWith('storage/old-primary');
    expect(storage.delete).toHaveBeenCalledWith('storage/old-secondary');
  });

  test('loads source bytes from object storage and verifies persisted integrity metadata', async () => {
    const sourceBytes = new TextEncoder().encode('stored outside Postgres');
    const hash = createHash('sha256').update(sourceBytes).digest('hex');
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('from public.project_sources')
            ? [
                {
                  byte_size: sourceBytes.byteLength,
                  mime_type: 'text/plain',
                  name: 'source.txt',
                  object_path: 'users/user-1/projects/hash/source-id/original',
                  source_hash: hash,
                },
              ]
            : []
        )
      ),
      { json: vi.fn((value: unknown) => value) }
    );
    const storage = {
      delete: vi.fn(),
      download: vi.fn(async () => sourceBytes),
      upload: vi.fn(),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const source = await store.loadProjectSource('user-1', PROJECT_META.id);

    expect(storage.download).toHaveBeenCalledWith('users/user-1/projects/hash/source-id/original', {
      byteSize: sourceBytes.byteLength,
      hash,
    });
    expect(source).toEqual({
      data: Buffer.from(sourceBytes).toString('base64'),
      mimeType: 'text/plain',
      name: 'source.txt',
    });
  });

  test('indexes an archive and stores every file as a separate immutable object', async () => {
    const zip = new JSZip();
    zip.file('docs/guide.md', '# Guide\n\nComplete documentation');
    zip.file('src/index.ts', 'export const value = 1;');
    zip.file('assets/blob.bin', new Uint8Array([0xff, 0xfe, 0x00]));
    const archiveBytes = await zip.generateAsync({ compression: 'DEFLATE', type: 'uint8array' });
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const saved = await store.saveProject('user-1', {
      ...createMultiSourceSnapshot(),
      sourceKind: 'codebase',
      source: {
        file: {
          data: Buffer.from(archiveBytes).toString('base64'),
          mimeType: 'application/zip',
          name: 'engine.zip',
        },
        index: {
          entries: [
            {
              byteSize: 4,
              contentKind: 'text',
              hash: 'fabricated',
              kind: 'file',
              path: 'fabricated.ts',
              preview: 'fake',
            },
          ],
        },
        kind: 'archive',
        name: 'engine.zip',
      },
    });

    expect(storage.upload).toHaveBeenCalledTimes(4);
    const uploadedPaths = storage.upload.mock.calls.map(([path]) => path);
    expect(uploadedPaths[0]).toMatch(/\/original$/u);
    expect(uploadedPaths.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/entries\/[0-9a-f]{64}$/u),
        expect.stringMatching(/\/entries\/[0-9a-f]{64}$/u),
        expect.stringMatching(/\/entries\/[0-9a-f]{64}$/u),
      ])
    );
    expect(
      transactionStatements.some(statement => statement.includes('project_source_entries'))
    ).toBe(true);
    expect(transactionStatements.every(statement => !/\bdata\b/u.test(statement))).toBe(true);
    const storedIndex = (
      saved.snapshot.source as {
        index: { entries: Array<{ path: string; preview?: string }> };
      }
    ).index;
    expect(storedIndex.entries.map(entry => entry.path)).toEqual([
      'assets',
      'assets/blob.bin',
      'docs',
      'docs/guide.md',
      'src',
      'src/index.ts',
    ]);
    expect(storedIndex.entries).not.toContainEqual(
      expect.objectContaining({ path: 'fabricated.ts' })
    );
    expect(storedIndex.entries).toContainEqual(
      expect.objectContaining({
        path: 'docs/guide.md',
        preview: '# Guide\n\nComplete documentation',
      })
    );
  });

  test('stops archive ingestion when the original object upload fails', async () => {
    const zip = new JSZip();
    zip.file('src/index.ts', 'export const value = 1;');
    const archiveBytes = await zip.generateAsync({ type: 'uint8array' });
    const transactionSql = Object.assign(
      vi.fn(async () => []),
      {
        json: vi.fn((value: unknown) => value),
      }
    );
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async (path: string) => {
        if (path.endsWith('/original')) {
          throw new ProjectSourceStorageError('upload-failed', 503);
        }
      }),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    await expect(
      store.saveProject('user-1', {
        ...createMultiSourceSnapshot(),
        sourceKind: 'codebase',
        source: {
          file: {
            data: Buffer.from(archiveBytes).toString('base64'),
            mimeType: 'application/zip',
            name: 'engine.zip',
          },
          index: { entries: [] },
          kind: 'archive',
          name: 'engine.zip',
        },
      })
    ).rejects.toMatchObject({ code: 'upload-failed' });

    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(sqlClient.begin).not.toHaveBeenCalled();
  });

  test('bounds concurrent archive uploads and starts the metadata transaction only afterwards', async () => {
    const zip = new JSZip();
    for (let index = 0; index < 6; index += 1) {
      zip.file(`src/file-${index}.ts`, `export const value${index} = ${index};`);
    }
    const archiveBytes = await zip.generateAsync({ type: 'uint8array' });
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: 1 }]
            : []
        )
      ),
      { json: vi.fn((value: unknown) => value) }
    );
    const sessionStatements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        sessionStatements.push(strings.join('?'));
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const pendingUploads: Array<() => void> = [];
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(
        () =>
          new Promise<void>(resolve => {
            activeUploads += 1;
            maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
            pendingUploads.push(() => {
              activeUploads -= 1;
              resolve();
            });
          })
      ),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const save = store.saveProject('user-1', {
      ...createMultiSourceSnapshot(),
      sourceKind: 'codebase',
      source: {
        file: {
          data: Buffer.from(archiveBytes).toString('base64'),
          mimeType: 'application/zip',
          name: 'engine.zip',
        },
        index: { entries: [] },
        kind: 'archive',
        name: 'engine.zip',
      },
    });

    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledTimes(4));
    expect(sqlClient.begin).not.toHaveBeenCalled();
    for (const resolve of pendingUploads.splice(0)) {
      resolve();
    }
    await vi.waitFor(() => expect(storage.upload).toHaveBeenCalledTimes(7));
    expect(sqlClient.begin).not.toHaveBeenCalled();
    for (const resolve of pendingUploads.splice(0)) {
      resolve();
    }
    await save;

    expect(maxActiveUploads).toBe(4);
    expect(sqlClient.begin).toHaveBeenCalledTimes(1);
    expect(
      sessionStatements.filter(statement => statement.includes('pg_advisory_lock('))
    ).toHaveLength(1);
    expect(
      sessionStatements.filter(statement => statement.includes('pg_advisory_unlock('))
    ).toHaveLength(1);
  });

  test('does not reindex or upload an unchanged embedded archive on a second full save', async () => {
    const zip = new JSZip();
    zip.file('src/index.ts', 'export const value = 1;');
    const archiveBytes = await zip.generateAsync({ type: 'uint8array' });
    const embeddedSnapshot = {
      ...createMultiSourceSnapshot(),
      sourceKind: 'codebase' as const,
      source: {
        file: {
          data: Buffer.from(archiveBytes).toString('base64'),
          mimeType: 'application/zip',
          name: 'engine.zip',
          sourceId: 'source-stable-archive',
        },
        index: { entries: [] },
        kind: 'archive' as const,
        name: 'engine.zip',
      },
    };
    let stored:
      | {
          meta: SavedProjectMeta;
          snapshot: ProjectSnapshot;
        }
      | undefined;
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        if (
          statement.includes('from public.projects') &&
          statement.includes('for update') &&
          stored
        ) {
          return Promise.resolve([{ id: stored.snapshot.id }]);
        }
        if (statement.includes('select snapshot, document_index') && stored) {
          return Promise.resolve([{ document_index: null, snapshot: stored.snapshot }]);
        }
        const ref = stored?.snapshot.source?.ref;
        if (statement.includes('source_kind') && ref) {
          return Promise.resolve([
            {
              byte_size: String(ref.byteSize),
              mime_type: ref.mimeType,
              name: ref.name,
              object_path: ref.objectPath,
              source_hash: ref.hash,
              source_id: ref.id,
              source_kind: 'archive',
            },
          ]);
        }
        if (statement.includes('from public.project_source_entries') && stored) {
          return Promise.resolve(
            stored.snapshot.source?.index?.entries.map(entry =>
              entry.kind === 'directory'
                ? {
                    byte_size: null,
                    content_kind: null,
                    kind: 'directory',
                    path: entry.path,
                    preview: null,
                    source_hash: null,
                  }
                : {
                    byte_size: entry.byteSize,
                    content_kind: entry.contentKind,
                    kind: 'file',
                    path: entry.path,
                    preview: entry.preview ?? null,
                    source_hash: entry.hash,
                  }
            ) || []
          );
        }
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: stored ? 2 : 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('from public.projects') && stored) {
          return Promise.resolve([{ meta: stored.meta, revision: stored.meta.revision || 1 }]);
        }
        if (statement.includes('from public.project_snapshots') && stored) {
          return Promise.resolve([{ document_index: null, snapshot: stored.snapshot }]);
        }
        if (statement.includes('source_kind') && stored) {
          const ref = stored.snapshot.source?.ref;
          return Promise.resolve([
            {
              byte_size: String(ref?.byteSize),
              mime_type: ref?.mimeType,
              name: ref?.name,
              object_path: ref?.objectPath,
              source_hash: ref?.hash,
              source_id: ref?.id,
              source_kind: 'archive',
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    stored = await store.saveProject('user-1', embeddedSnapshot);
    storage.upload.mockClear();
    storage.download.mockClear();
    storage.delete.mockClear();
    transactionStatements.length = 0;

    const sourceOmitted = await store.saveProject('user-1', {
      ...embeddedSnapshot,
      source: null,
    });
    expect(sourceOmitted.snapshot.source?.ref).toEqual(stored.snapshot.source?.ref);
    expect(sourceOmitted.snapshot.sourceKind).toBe(stored.snapshot.sourceKind);
    stored = sourceOmitted;

    const second = await store.saveProject('user-1', {
      ...embeddedSnapshot,
      source: {
        ...embeddedSnapshot.source,
        index: {
          entries: [
            {
              byteSize: 4,
              contentKind: 'text',
              hash: 'fabricated',
              kind: 'file',
              path: 'fabricated.ts',
              preview: 'fake',
            },
          ],
        },
      },
    });

    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(second.snapshot.source?.file.data).toBe('');
    expect(second.snapshot.source?.ref).toEqual(stored.snapshot.source?.ref);
    expect(second.snapshot.source?.index).toEqual(stored.snapshot.source?.index);
    expect(
      transactionStatements.some(
        statement =>
          statement.includes('insert into public.project_source_entries') ||
          statement.includes('delete from public.project_source_entries')
      )
    ).toBe(false);
    expect(
      transactionStatements.some(
        statement =>
          statement.includes('insert into public.project_source_files') ||
          statement.includes('delete from public.project_source_files')
      )
    ).toBe(false);

    const canonicalized = await store.saveProject('user-1', {
      ...second.snapshot,
      source: {
        ...second.snapshot.source,
        index: {
          entries: [
            {
              byteSize: 4,
              contentKind: 'text',
              hash: 'fabricated',
              kind: 'file',
              path: 'fabricated.ts',
            },
          ],
        },
        ref: {
          ...second.snapshot.source?.ref,
          hash: 'fabricated',
          objectPath: 'fabricated/path',
        },
      },
    });
    expect(canonicalized.snapshot.source?.ref).toEqual(stored.snapshot.source?.ref);
    expect(canonicalized.snapshot.source?.index).toEqual(stored.snapshot.source?.index);

    await expect(
      store.saveProject('user-1', {
        ...second.snapshot,
        source: {
          ...second.snapshot.source,
          ref: {
            ...second.snapshot.source?.ref,
            id: 'source-wrong',
          },
        },
      })
    ).rejects.toThrow('identity does not match');
  });

  test('does not upload an unchanged embedded source set on a second full save', async () => {
    let stored:
      | {
          meta: SavedProjectMeta;
          snapshot: ProjectSnapshot;
        }
      | undefined;
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        if (
          statement.includes('from public.projects') &&
          statement.includes('for update') &&
          stored
        ) {
          return Promise.resolve([{ id: stored.snapshot.id }]);
        }
        if (statement.includes('select snapshot, document_index') && stored) {
          return Promise.resolve([{ document_index: null, snapshot: stored.snapshot }]);
        }
        const refs = stored?.snapshot.source?.sources?.map(source => source.ref) || [];
        if (statement.includes('source_kind') && refs[0]) {
          const ref = refs[0];
          return Promise.resolve([
            {
              byte_size: String(ref.byteSize),
              mime_type: ref.mimeType,
              name: ref.name,
              object_path: ref.objectPath,
              source_hash: ref.hash,
              source_id: ref.id,
              source_kind: 'file',
            },
          ]);
        }
        if (statement.includes('from public.project_source_files') && stored) {
          return Promise.resolve(
            refs.map((ref, position) => ({
              byte_size: String(ref?.byteSize),
              mime_type: ref?.mimeType,
              name: ref?.name,
              object_path: ref?.objectPath,
              position,
              source_hash: ref?.hash,
              source_id: ref?.id,
            }))
          );
        }
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: PROJECT_META, revision: stored ? 2 : 1 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('from public.projects') && stored) {
          return Promise.resolve([{ meta: stored.meta, revision: stored.meta.revision || 1 }]);
        }
        if (statement.includes('from public.project_snapshots') && stored) {
          return Promise.resolve([{ document_index: null, snapshot: stored.snapshot }]);
        }
        const refs = stored?.snapshot.source?.sources?.map(source => source.ref) || [];
        if (statement.includes('source_kind') && stored) {
          const ref = refs[0];
          return Promise.resolve([
            {
              byte_size: String(ref?.byteSize),
              mime_type: ref?.mimeType,
              name: ref?.name,
              object_path: ref?.objectPath,
              source_hash: ref?.hash,
              source_id: ref?.id,
              source_kind: 'file',
            },
          ]);
        }
        if (statement.includes('from public.project_source_files') && stored) {
          return Promise.resolve(
            refs.map((ref, position) => ({
              byte_size: String(ref?.byteSize),
              mime_type: ref?.mimeType,
              name: ref?.name,
              object_path: ref?.objectPath,
              position,
              source_hash: ref?.hash,
              source_id: ref?.id,
            }))
          );
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(async () => undefined),
    };
    const store = createPostgresProjectStore(sqlClient, storage);
    const embeddedSnapshot = createMultiSourceSnapshot();

    stored = await store.saveProject('user-1', embeddedSnapshot);
    storage.upload.mockClear();
    storage.download.mockClear();
    storage.delete.mockClear();
    transactionStatements.length = 0;

    const second = await store.saveProject('user-1', embeddedSnapshot);

    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(second.snapshot.source?.sources?.every(source => !source.file.data && source.ref)).toBe(
      true
    );
    expect(
      transactionStatements.some(
        statement =>
          statement.includes('insert into public.project_source_files') ||
          statement.includes('delete from public.project_source_files')
      )
    ).toBe(false);

    const canonicalized = await store.saveProject('user-1', {
      ...second.snapshot,
      source: {
        ...second.snapshot.source,
        sources: second.snapshot.source?.sources?.map(source => ({
          ...source,
          hash: 'fabricated',
          ref: {
            ...source.ref,
            hash: 'fabricated',
            objectPath: 'fabricated/path',
          },
        })),
      },
    });
    expect(canonicalized.snapshot.source?.sources?.map(source => source.ref)).toEqual(
      stored.snapshot.source?.sources?.map(source => source.ref)
    );

    const firstDescriptor = second.snapshot.source?.sources?.[0];
    await expect(
      store.saveProject('user-1', {
        ...second.snapshot,
        source: {
          ...second.snapshot.source,
          sources: firstDescriptor
            ? [
                { ...firstDescriptor, id: 'source-wrong' },
                ...second.snapshot.source.sources.slice(1),
              ]
            : [],
        },
      })
    ).rejects.toThrow(/reference is missing|does not match/u);
  });

  test('loads archive metadata separately and verifies entry bytes through Storage', async () => {
    const entryBytes = new TextEncoder().encode('complete entry');
    const entryHash = createHash('sha256').update(entryBytes).digest('hex');
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('from public.project_sources source')) {
          return Promise.resolve([
            {
              archive_source_hash: 'a'.repeat(64),
              archive_source_id: 'source-archive',
              byte_size: null,
              content_kind: null,
              kind: 'directory',
              path: 'src',
              preview: null,
              source_hash: null,
              source_kind: 'archive',
            },
            {
              archive_source_hash: 'a'.repeat(64),
              archive_source_id: 'source-archive',
              byte_size: entryBytes.byteLength,
              content_kind: 'text',
              kind: 'file',
              path: 'src/index.ts',
              preview: 'complete entry',
              source_hash: entryHash,
              source_kind: 'archive',
            },
          ]);
        }
        if (
          statement.includes('from public.project_source_entries') &&
          statement.includes('path =')
        ) {
          return Promise.resolve([
            {
              byte_size: entryBytes.byteLength,
              content_kind: 'text',
              object_path: 'users/user/projects/hash/source/entries/hash',
              source_hash: entryHash,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const storage = {
      delete: vi.fn(),
      download: vi.fn(async () => entryBytes),
      downloadRange: vi.fn(async () => entryBytes.slice(2, 9)),
      upload: vi.fn(),
    };
    const store = createPostgresProjectStore(sqlClient, storage);

    const index = await store.loadProjectSourceArchiveIndex('user-1', PROJECT_META.id);
    const loadedEntry = await store.loadProjectSourceArchiveEntry(
      'user-1',
      PROJECT_META.id,
      'src/index.ts',
      {
        sourceHash: 'a'.repeat(64),
        sourceId: 'source-archive',
      }
    );
    const loadedRange = await store.loadProjectSourceArchiveEntryRange(
      'user-1',
      PROJECT_META.id,
      'src/index.ts',
      {
        sourceHash: 'a'.repeat(64),
        sourceId: 'source-archive',
      },
      2,
      9
    );

    expect(index).toEqual({
      entries: [
        { kind: 'directory', path: 'src' },
        {
          byteSize: entryBytes.byteLength,
          contentKind: 'text',
          hash: entryHash,
          kind: 'file',
          path: 'src/index.ts',
          preview: 'complete entry',
        },
      ],
      version: {
        sourceHash: 'a'.repeat(64),
        sourceId: 'source-archive',
      },
    });
    expect(storage.download).toHaveBeenCalledWith('users/user/projects/hash/source/entries/hash', {
      byteSize: entryBytes.byteLength,
      hash: entryHash,
    });
    expect(storage.downloadRange).toHaveBeenCalledWith(
      'users/user/projects/hash/source/entries/hash',
      entryBytes.byteLength,
      2,
      9
    );
    expect(loadedEntry).toEqual(entryBytes);
    expect(loadedRange).toEqual(entryBytes.slice(2, 9));
  });

  test('saves a cover only while the project revision still matches', async () => {
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        statements.push(statement);
        return Promise.resolve(
          statement.includes('select meta, revision') ? [{ meta: PROJECT_META, revision: 4 }] : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const store = createPostgresProjectStore(sqlClient);

    const saved = await store.saveProjectCover(
      'user-1',
      PROJECT_META.id,
      { data: 'ZmFrZQ==', mimeType: 'image/png', name: 'cover-p2.png' },
      { expectedRevision: 3 }
    );

    expect(saved).toBe(false);
    expect(statements[0]).toContain('from public.projects');
    expect(statements[0]).toContain('revision =');
    expect(statements[0]).toContain('for key share');
  });

  test('locks project deletion against an in-flight conditional cover save', async () => {
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        transactionStatements.push(strings.join('?'));
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(vi.fn(), {
      begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
        operation(transactionSql)
      ),
      json: vi.fn((value: unknown) => value),
    });
    const storage = {
      delete: vi.fn(async () => undefined),
      download: vi.fn(),
      upload: vi.fn(),
    };
    const projectAssetDeletions = {
      claimNextQueuedObject: vi.fn(async () => null),
      cleanupQueuedObject: vi.fn(async () => 'deleted' as const),
      queueProjectAssets: vi.fn(async () => ['asset/object/path']),
    };
    const store = createPostgresProjectStore(sqlClient, storage, projectAssetDeletions);

    await store.deleteProject('user-1', PROJECT_META.id);

    expect(sqlClient.begin).toHaveBeenCalledTimes(1);
    expect(transactionStatements[0]).toContain('for update');
    expect(
      transactionStatements.filter(statement => statement.includes('select object_path'))
    ).toHaveLength(3);
    expect(
      transactionStatements.some(statement => statement.includes('project_source_deletions'))
    ).toBe(true);
    expect(
      transactionStatements.some(statement =>
        statement.includes('delete from public.project_covers')
      )
    ).toBe(true);
    expect(transactionStatements.at(-1)).toContain('delete from public.projects');
    expect(projectAssetDeletions.queueProjectAssets).toHaveBeenCalledWith(transactionSql, {
      projectId: PROJECT_META.id,
      userId: 'user-1',
    });
    expect(projectAssetDeletions.cleanupQueuedObject).not.toHaveBeenCalled();
  });

  test('touchProject updates metadata without loading the project snapshot', async () => {
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        statements.push(statement);
        return Promise.resolve(
          statement.includes('select meta') ||
            statement.includes('returning meta') ||
            statement.includes('returning id')
            ? [{ meta: PROJECT_META, revision: 2 }]
            : []
        );
      }),
      {
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await store.touchProject('user-1', PROJECT_META.id);

    expect(statements).toHaveLength(1);
    expect(statements.some(statement => statement.includes('project_snapshots'))).toBe(false);
    expect(statements[0]).toContain('update public.projects');
    expect(statements[0]).toContain("jsonb_set(meta, '{updatedAt}'");
    expect(statements[0]).toContain("'{lastOpenedAt}'");
  });

  test('preserves the current favorite during an unconditional snapshot save', async () => {
    const existingSnapshot: ProjectSnapshot = {
      id: PROJECT_META.id,
      version: '4.1',
      sourceKind: 'document',
      learningPlan: { title: 'Reti', sections: [] },
      createdAt: PROJECT_META.createdAt,
      updatedAt: PROJECT_META.updatedAt,
      lastOpenedAt: PROJECT_META.lastOpenedAt,
    };
    const transactionStatements: string[] = [];
    const favoriteMeta = { ...PROJECT_META, isFavorite: true };
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        if (statement.includes('from public.projects') && statement.includes('for update')) {
          return Promise.resolve([{ id: PROJECT_META.id }]);
        }
        if (statement.includes('select snapshot, document_index')) {
          return Promise.resolve([{ document_index: null, snapshot: existingSnapshot }]);
        }
        return Promise.resolve(
          statement.includes('returning meta, revision')
            ? [{ meta: favoriteMeta, revision: 2 }]
            : []
        );
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('select meta')) {
          return Promise.resolve([{ meta: PROJECT_META, revision: 1 }]);
        }
        if (statement.includes('project_snapshots')) {
          return Promise.resolve([{ document_index: null, snapshot: existingSnapshot }]);
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    const saved = await store.saveProject('user-1', {
      ...existingSnapshot,
      updatedAt: '2026-07-07T11:00:00.000Z',
    });

    expect(saved.meta).toMatchObject({ isFavorite: true, revision: 2 });
    const metaUpdate = transactionStatements.find(statement =>
      statement.includes('update public.projects')
    );
    expect(metaUpdate).toContain("coalesce(meta -> 'isFavorite', 'false'::jsonb)");
    expect(
      transactionStatements.some(statement => statement.includes('update public.project_assets'))
    ).toBe(false);
  });

  test('bounds import diagnostics to the active retention window', async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray, ...parameters: unknown[]) => {
        statements.push(strings.join('?'));
        values.push(parameters);
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await store.listProjectImportDiagnostics('550e8400-e29b-41d4-a716-446655440000');

    expect(statements[1]).toContain('created_at >= now()');
    expect(statements[1]).toContain('order by created_at desc, id desc');
    expect(statements[1]).toContain('limit');
    expect(values[1]).toEqual(
      expect.arrayContaining([30, '550e8400-e29b-41d4-a716-446655440000', 200])
    );
  });

  test('does not report a committed archive import as failed when lock release fails', async () => {
    const snapshot = createMultiSourceSnapshot();
    const archive = await createProjectBackupArchive(
      { project: snapshot },
      {
        invalidArchiveMessage: 'Invalid project backup.',
        maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
        maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
        maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
      }
    );
    const release = vi.fn(async () => {
      throw new Error('unlock failed');
    });
    const importer = {
      prepare: vi.fn(async ({ projectId }: { projectId: string }) => ({
        assets: [],
        release,
        snapshot: { ...snapshot, id: projectId },
      })),
    };
    const sqlClient = Object.assign(
      vi.fn(async () => []),
      {
        begin: vi.fn(),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = new PostgresProjectStore(
      undefined,
      sqlClient as never,
      undefined,
      undefined,
      importer as never
    );
    const saved = {
      meta: { ...PROJECT_META, id: 'import-target' },
      snapshot: { ...snapshot, id: 'import-target' },
    };
    vi.spyOn(store, 'saveProject').mockResolvedValue(saved);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(store.importProjectArchive('user-1', archive, 'import-target')).resolves.toEqual(
      saved
    );
    expect(release).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      '[Projects] Failed to release imported project asset locks.',
      expect.objectContaining({ projectId: 'import-target' })
    );
  });

  test('rolls back before writing the snapshot when the expected revision lost a race', async () => {
    const snapshot: ProjectSnapshot = {
      id: PROJECT_META.id,
      version: '4.1',
      sourceKind: 'document',
      learningPlan: { title: 'Reti aggiornate', sections: [] },
      createdAt: PROJECT_META.createdAt,
      updatedAt: '2026-07-07T11:00:00.000Z',
      lastOpenedAt: PROJECT_META.lastOpenedAt,
    };
    const transactionStatements: string[] = [];
    const transactionSql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        transactionStatements.push(statement);
        if (statement.includes('from public.projects') && statement.includes('for update')) {
          return Promise.resolve([{ id: PROJECT_META.id }]);
        }
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        if (statement.includes('select meta')) {
          return Promise.resolve([{ meta: PROJECT_META, revision: 1 }]);
        }
        if (statement.includes('select snapshot')) {
          return Promise.resolve([{ document_index: null, snapshot }]);
        }
        return Promise.resolve([]);
      }),
      {
        begin: vi.fn(async (operation: (sql: typeof transactionSql) => Promise<unknown>) =>
          operation(transactionSql)
        ),
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = createPostgresProjectStore(sqlClient);

    await expect(
      store.saveProject('user-1', snapshot, { expectedRevision: 1 })
    ).rejects.toBeInstanceOf(ProjectRevisionConflictError);

    expect(transactionStatements.some(statement => statement.includes('and revision ='))).toBe(
      true
    );
    expect(transactionStatements.some(statement => statement.includes('project_snapshots'))).toBe(
      false
    );
  });
});
