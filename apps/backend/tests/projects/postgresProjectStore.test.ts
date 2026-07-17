import { describe, expect, test, vi } from 'vitest';

import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import { ProjectRevisionConflictError } from '../../src/projects/projectRevision.js';
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

describe('PostgresProjectStore', () => {
  test('saves a cover only while the project revision still matches', async () => {
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        statements.push(strings.join('?'));
        return Promise.resolve([]);
      }),
      { json: vi.fn((value: unknown) => value) }
    );
    const store = new PostgresProjectStore(undefined, sqlClient as never);

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
    const store = new PostgresProjectStore(undefined, sqlClient as never);

    await store.deleteProject('user-1', PROJECT_META.id);

    expect(sqlClient.begin).toHaveBeenCalledTimes(1);
    expect(transactionStatements).toHaveLength(4);
    expect(transactionStatements[0]).toContain('for update');
    expect(transactionStatements[1]).toContain('delete from public.project_covers');
    expect(transactionStatements[3]).toContain('delete from public.projects');
  });

  test('touchProject updates metadata without loading the project snapshot', async () => {
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        statements.push(statement);
        return Promise.resolve(
          statement.includes('select meta') || statement.includes('returning meta')
            ? [{ meta: PROJECT_META, revision: 2 }]
            : []
        );
      }),
      {
        json: vi.fn((value: unknown) => value),
      }
    );
    const store = new PostgresProjectStore(undefined, sqlClient as never);

    await store.touchProject('user-1', PROJECT_META.id);

    expect(statements.some(statement => statement.includes('project_snapshots'))).toBe(false);
    expect(statements.some(statement => statement.includes('update public.projects'))).toBe(true);
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
        transactionStatements.push(strings.join('?'));
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
    const store = new PostgresProjectStore(undefined, sqlClient as never);

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
