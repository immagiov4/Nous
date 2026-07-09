import { describe, expect, test, vi } from 'vitest';

import { PostgresProjectStore } from '../../src/projects/postgresProjectStore.js';
import type { SavedProjectMeta } from '../../src/projects/types.js';

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
  syncState: 'sync-ready',
};

describe('PostgresProjectStore', () => {
  test('touchProject updates metadata without loading the project snapshot', async () => {
    const statements: string[] = [];
    const sqlClient = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const statement = strings.join('?');
        statements.push(statement);
        return Promise.resolve(statement.includes('select meta') ? [{ meta: PROJECT_META }] : []);
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
});
